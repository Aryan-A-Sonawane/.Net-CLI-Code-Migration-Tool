using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;

class Program
{
    static async Task Main(string[] args)
    {
        if (args.Length != 1)
        {
            Console.Error.WriteLine("Usage: analyzer.exe <path-to-csproj>");
            return;
        }

        try
        {
            string csprojPath = Path.GetFullPath(args[0]);
            if (!File.Exists(csprojPath))
            {
                Console.Error.WriteLine($"Error: .csproj file not found at {csprojPath}");
                return;
            }

            string projectDir = Path.GetDirectoryName(csprojPath);
            var deprecatedNamespaces = new List<string>();
            var deprecatedApis = new List<string>();

            string[] csFiles = Directory.GetFiles(projectDir, "*.cs", SearchOption.AllDirectories);
            foreach (string csFile in csFiles)
            {
                string code = await File.ReadAllTextAsync(csFile);
                var tree = CSharpSyntaxTree.ParseText(code);
                var root = await tree.GetRootAsync();

                var namespaces = root.DescendantNodes()
                    .OfType<UsingDirectiveSyntax>()
                    .Where(u => u.Name.ToString().StartsWith("System.Web") || u.Name.ToString().StartsWith("System.Drawing"))
                    .Select(u => u.Name.ToString())
                    .Distinct();
                deprecatedNamespaces.AddRange(namespaces);

                var identifiers = root.DescendantNodes()
                    .OfType<MemberAccessExpressionSyntax>()
                    .Where(m => m.ToString().Contains("HttpContext.Current"))
                    .Select(m => m.ToString());
                deprecatedApis.AddRange(identifiers);
            }

            var analysis = new
            {
                DeprecatedNamespaces = deprecatedNamespaces,
                DeprecatedApis = deprecatedApis,
                FileCount = csFiles.Length
            };
            Console.WriteLine(JsonSerializer.Serialize(analysis, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Error: {ex.Message}");
        }
    }
}