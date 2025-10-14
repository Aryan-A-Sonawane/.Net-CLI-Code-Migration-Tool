# 🧭 .NET CLI Migration Tool

Welcome to the **.NET CLI Migration Tool**, a cutting-edge solution designed to streamline the migration of **.NET Framework** projects to **.NET 9.0**.  
Built with advanced code analysis, automated refactoring, and an optional **LLM-based migration mode**, this tool helps developers identify deprecated libraries, suggest modern replacements, and simplify the migration process.  

> 🕒 *Last updated at 11:23 AM IST on Tuesday, October 14, 2025.*

---

## ✨ Features

### 🧩 Deprecated Library Detection
- Uses **Roslyn semantic analysis** to identify outdated namespaces such as:
  - `System.Web`
  - `System.Drawing`
  - `System.Data.OracleClient`
  - `System.Transactions`

### ⚙️ Code Migration Assistance
- Automatically rewrites or annotates code with migration suggestions.
- Example:
  ```csharp
  // Before
  var context = HttpContext.Current;

  // After
  var context = httpContextAccessor.HttpContext;
