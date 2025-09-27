# .NET CLI Migration Tool

Welcome to the **.NET CLI Migration Tool**, a cutting-edge solution designed to streamline the migration of .NET Framework projects to .NET Core 8.0. Built with advanced code analysis and automated refactoring, this tool helps developers identify deprecated libraries, suggest modern replacements, and simplify the transition process. Last updated at **01:08 AM IST on Sunday, September 28, 2025**.

## ✨ Features

- **Deprecated Library Detection**: Uses Roslyn semantic analysis to identify outdated namespaces (e.g., `System.Web`, `System.Drawing`, `System.Data.OracleClient`, `System.Transactions`) and APIs (e.g., `HttpContext.Current`).
- **Code Migration Assistance**: Automatically rewrites code with suggestions like replacing `HttpContext.Current` with `IHttpContextAccessor.HttpContext` or adding TODO comments for manual review.
- **Interactive UI**: A React-based frontend featuring a tree view (via React-Arborist), Monaco Editor for code comparison, and a summary panel displaying analysis results.
- **File Upload Support**: Accepts `.csproj` files or ZIP archives for flexible project analysis.
- **Semantic Graph Visualization**: Integrates with Neo4j Aura to generate dependency graphs (optional), enhancing code relationship insights.
- **Customizable Themes**: Offers light and dark mode switching for a comfortable user experience.
- **Error Handling**: Continues analysis even if Neo4j connectivity fails, ensuring robust operation.

## 🎯 Project Goals

The tool aims to:
- Accelerate the migration of legacy .NET Framework applications to .NET Core 8.0.
- Reduce manual effort by flagging deprecated components and providing actionable suggestions.
- Ensure compatibility with modern .NET standards through Roslyn-powered analysis.

## 🛠 Tech Stack

- **Backend**: Node.js with Express, Multer for file uploads, Axios for API requests, and CORS for cross-origin support.
- **Analyzer**: C# with Microsoft.CodeAnalysis (Roslyn) for semantic checking and code rewriting, compiled to `analyzer.exe` targeting .NET 9.0.
- **Database**: Neo4j Aura for optional semantic graph storage.
- **Frontend**: React with Ant Design components, React-Arborist for tree visualization, and Monaco Editor for code editing.
- **Styling**: Custom CSS with theme toggling.
- **Development Tools**: npm for package management, Git for version control.

## 🚀 Getting Started

### Prerequisites
- Node.js (v14 or later)
- .NET SDK (v9.0 for building `analyzer.exe`)
- Neo4j Aura account (optional for graph features)


