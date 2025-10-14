using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Neo4j.Driver;
using Microsoft.CodeAnalysis.MSBuild;

namespace Analyzer
{
    class Program
    {
        private static readonly string Neo4jUri = "neo4j+s://b8cac1b8.databases.neo4j.io";
        private static readonly string Neo4jUser = "neo4j";
        private static readonly string Neo4jPassword = "WdvWJgEOcboJyssTvyivZnr5RdrinwioDyu4NUZvhvI";

        static async Task<int> Main(string[] args)
        {
            if (args.Length != 1)
            {
                Console.Error.WriteLine("Usage: analyzer.exe <path-to-csproj>");
                return 1;
            }

            try
            {
                string csprojPath = Path.GetFullPath(args[0]);
                if (!File.Exists(csprojPath))
                {
                    Console.Error.WriteLine($"Error: .csproj file not found at {csprojPath}");
                    return 1;
                }

                string projectDir = Path.GetDirectoryName(csprojPath)!;
                var deprecatedNamespaces = new HashSet<string> { "System.Web", "System.Drawing", "System.Data.OracleClient", "System.Transactions" };
                var deprecatedApis = new HashSet<string>();
                var syntaxTreeData = new List<object>();
                var semanticGraph = new List<object>();
                var migratedFiles = new Dictionary<string, object>();
                var projectStructure = new List<object>();

                // Build project structure
                async Task BuildProjectStructure(string dir, List<object> structure, string relativePath = "")
                {
                    var entries = Directory.GetFileSystemEntries(dir);
                    foreach (var entry in entries)
                    {
                        var entryName = Path.GetFileName(entry);
                        var entryRelativePath = Path.Combine(relativePath, entryName);
                        var entryNode = new
                        {
                            Name = entryName,
                            Path = entryRelativePath.Replace("\\", "/"),
                            Type = Directory.Exists(entry) ? "directory" : "file"
                        };

                        if (Directory.Exists(entry))
                        {
                            var children = new List<object>();
                            await BuildProjectStructure(entry, children, entryRelativePath);
                            structure.Add(new { entryNode.Name, entryNode.Path, entryNode.Type, Children = children });
                        }
                        else
                        {
                            structure.Add(entryNode);
                        }
                    }
                }

                await BuildProjectStructure(projectDir, projectStructure);

                // Attempt Neo4j connection (optional)
                bool neo4jConnected = false;
                try
                {
                    using var driver = GraphDatabase.Driver(Neo4jUri, AuthTokens.Basic(Neo4jUser, Neo4jPassword));
                    await driver.VerifyConnectivityAsync();
                    neo4jConnected = true;
                    var session = driver.AsyncSession();
                    try
                    {
                        var tx = await session.BeginTransactionAsync();
                        await tx.RunAsync("MATCH (n) DETACH DELETE n");
                        await tx.CommitAsync();
                    }
                    finally
                    {
                        await session.CloseAsync();
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"Neo4j connection failed: {ex.Message}. Continuing without graph storage.");
                }

                string[] csFiles = Directory.GetFiles(projectDir, "*.cs", SearchOption.AllDirectories);
                using var workspace = new AdhocWorkspace();
                var projectInfo = ProjectInfo.Create(
                    ProjectId.CreateNewId(),
                    VersionStamp.Create(),
                    "MigrationProject",
                    "MigrationProject",
                    LanguageNames.CSharp
                );
                var project = workspace.AddProject(projectInfo);

                var documentIds = new Dictionary<string, DocumentId>();
                foreach (string csFile in csFiles)
                {
                    string code = await File.ReadAllTextAsync(csFile);
                    var docId = DocumentId.CreateNewId(project.Id, Path.GetFileName(csFile));
                    workspace.AddDocument(DocumentInfo.Create(
                        docId,
                        Path.GetFileName(csFile),
                        filePath: csFile,
                        loader: TextLoader.From(TextAndVersion.Create(SourceText.From(code), VersionStamp.Create()))
                    ));
                    documentIds[csFile] = docId;
                }

                project = workspace.CurrentSolution.Projects.First();

                foreach (string csFile in csFiles)
                {
                    string code = await File.ReadAllTextAsync(csFile);
                    var tree = CSharpSyntaxTree.ParseText(code);
                    var root = await tree.GetRootAsync();

                    var document = project.GetDocument(documentIds[csFile]);
                    var semanticModel = await document!.GetSemanticModelAsync();
                    if (semanticModel == null)
                    {
                        Console.Error.WriteLine($"Warning: Could not get semantic model for {csFile}. Skipping analysis.");
                        continue;
                    }

                    var namespaces = root.DescendantNodes()
                        .OfType<UsingDirectiveSyntax>()
                        .Where(u => u.Name != null && deprecatedNamespaces.Contains(u.Name.ToString()))
                        .Select(u => u.Name!.ToString())
                        .Distinct();
                    foreach (var ns in namespaces)
                    {
                        deprecatedNamespaces.Add(ns);
                    }

                    var deprecatedApiSymbols = new List<string>();
                    foreach (var memberAccess in root.DescendantNodes().OfType<MemberAccessExpressionSyntax>())
                    {
                        var symbol = semanticModel.GetSymbolInfo(memberAccess).Symbol;
                        if (symbol != null)
                        {
                            var containingNs = symbol.ContainingNamespace?.ToString() ?? "";
                            if (deprecatedNamespaces.Any(ns => containingNs.StartsWith(ns)))
                            {
                                deprecatedApiSymbols.Add(memberAccess.ToString());
                            }
                        }
                        if (memberAccess.ToString() == "HttpContext.Current")
                        {
                            deprecatedApiSymbols.Add("HttpContext.Current");
                        }
                    }

                    foreach (var api in deprecatedApiSymbols)
                    {
                        deprecatedApis.Add(api);
                    }

                    var identifiers = deprecatedApiSymbols;
                    var nodes = root.DescendantNodes()
                        .Where(n => n is ClassDeclarationSyntax || n is MethodDeclarationSyntax)
                        .Select(n => new
                        {
                            Type = n.GetType().Name,
                            Name = n switch
                            {
                                ClassDeclarationSyntax cds => cds.Identifier.ValueText,
                                MethodDeclarationSyntax mds => mds.Identifier.ValueText,
                                _ => null
                            },
                            Line = n.GetLocation().GetLineSpan().StartLinePosition.Line + 1,
                            Issues = identifiers.Where(identifier => n.ToString().Contains(identifier))
                                .Select(identifier => $"Uses deprecated API: {identifier} (Consider replacing with .NET 9.0 equivalent)")
                                .ToList(),
                            FilePath = csFile
                        })
                        .Where(n => n.Name != null);
                    syntaxTreeData.AddRange(nodes);

                    if (neo4jConnected)
                    {
                        var graphNodes = nodes.Select(n => new
                        {
                            Id = Guid.NewGuid().ToString(),
                            Label = n.Name,
                            Type = n.Type,
                            FilePath = n.FilePath
                        });
                        var graphEdges = nodes
                            .Where(n => n.Issues.Any())
                            .SelectMany(n => nodes
                                .Where(m => m.Line > n.Line && Path.GetFileName(m.FilePath) == Path.GetFileName(n.FilePath))
                                .Select(m => new
                                {
                                    Source = n.Name,
                                    Target = m.Name,
                                    Type = "DEPENDS_ON"
                                }));

                        using var driver2 = GraphDatabase.Driver(Neo4jUri, AuthTokens.Basic(Neo4jUser, Neo4jPassword));
                        var session2 = driver2.AsyncSession();
                        try
                        {
                            var tx = await session2.BeginTransactionAsync();
                            await tx.RunAsync(
                                "UNWIND $nodes AS node MERGE (n:Node {id: node.Id, label: node.Label, type: node.Type, filePath: node.FilePath})",
                                new { nodes = graphNodes }
                            );
                            await tx.RunAsync(
                                "UNWIND $edges AS edge MERGE (s:Node {label: edge.Source}) MERGE (t:Node {label: edge.Target}) MERGE (s)-[:DEPENDS_ON]->(t)",
                                new { edges = graphEdges }
                            );
                            await tx.CommitAsync();
                            semanticGraph.AddRange(graphNodes);
                            semanticGraph.AddRange(graphEdges);
                        }
                        finally
                        {
                            await session2.CloseAsync();
                        }
                    }

                    var rewriter = new DeprecatedApiRewriter(semanticModel);
                    var migratedRoot = rewriter.Visit(root);

                    if (!migratedRoot.IsEquivalentTo(root))
                    {
                        migratedFiles[csFile] = new
                        {
                            Original = code,
                            Migrated = migratedRoot.ToFullString(),
                            Changes = rewriter.Changes
                        };
                    }
                }

                var analysis = new
                {
                    DeprecatedNamespaces = deprecatedNamespaces.ToList(),
                    DeprecatedApis = deprecatedApis.ToList(),
                    FileCount = csFiles.Length,
                    SyntaxTreeData = syntaxTreeData,
                    SemanticGraph = semanticGraph,
                    MigratedFiles = migratedFiles,
                    ProjectStructure = projectStructure
                };
                Console.WriteLine(JsonSerializer.Serialize(analysis, new JsonSerializerOptions { WriteIndented = true }));
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Error: {ex.Message}");
                return 1;
            }
        }
    }

    class DeprecatedApiRewriter : CSharpSyntaxRewriter
    {
        private readonly SemanticModel _semanticModel;
        public List<string> Changes { get; } = new List<string>();

        public DeprecatedApiRewriter(SemanticModel semanticModel)
        {
            _semanticModel = semanticModel ?? throw new ArgumentNullException(nameof(semanticModel));
        }

        public override SyntaxNode? VisitMemberAccessExpression(MemberAccessExpressionSyntax node)
        {
            var symbol = _semanticModel.GetSymbolInfo(node).Symbol;
            if (symbol != null)
            {
                var containingNs = symbol.ContainingNamespace?.ToString() ?? "";
                var deprecatedNamespaces = new HashSet<string> { "System.Web", "System.Drawing", "System.Data.OracleClient", "System.Transactions" };
                if (deprecatedNamespaces.Any(ns => containingNs.StartsWith(ns)))
                {
                    string? replacement = GetReplacement(node.ToString());
                    if (!string.IsNullOrEmpty(replacement))
                    {
                        Changes.Add($"Replaced '{node}' with '{replacement}'");
                        return SyntaxFactory.ParseExpression(replacement).WithTriviaFrom(node);
                    }
                    else
                    {
                        Changes.Add($"Deprecated API '{node}' detected (No direct replacement available, consider manual review for .NET 9.0)");
                        var commentTrivia = SyntaxFactory.Comment($"// TODO: Replace {node} with .NET 9.0 equivalent");
                        return node.WithLeadingTrivia(node.GetLeadingTrivia().Add(commentTrivia));
                    }
                }
            }
            return base.VisitMemberAccessExpression(node);
        }

        private string? GetReplacement(string deprecatedApi)
        {
            return deprecatedApi switch
            {
                "HttpContext.Current" => "IHttpContextAccessor.HttpContext",
                "System.Web.HttpUtility.HtmlEncode" => "System.Net.WebUtility.HtmlEncode",
                "System.Drawing.Image" => "SkiaSharp.SKBitmap",
                "System.Transactions.TransactionScope" => "System.Transactions.TransactionScopeAsyncFlowOption",
                _ => null
            };
        }
    }
}