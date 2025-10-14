require("dotenv").config();
const fs = require("fs");
const fsPromises = require("fs").promises;
const express = require("express");
const multer = require("multer");
const path = require("path");
const { exec } = require("child_process");
const axios = require("axios");
const cors = require("cors");
const unzipper = require("unzipper");
const AdmZip = require("adm-zip");

const app = express();
const upload = multer({
  dest: "Uploads/",
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.use(cors({ origin: "http://localhost:3000" }));
app.use(express.json());

// Configure static file serving
const frontendBuildPath = path.join(__dirname, "../frontend/build");
if (!fs.existsSync(frontendBuildPath)) {
  console.error(`Error: Frontend build directory not found at ${frontendBuildPath}. Please run 'npm run build' in the frontend directory.`);
  process.exit(1); // Exit if build is missing
}
app.use(express.static(frontendBuildPath));

// Fallback to serve index.html for all routes
app.get("*", (req, res) => {
  const indexPath = path.join(frontendBuildPath, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(500).json({ error: "Frontend build corrupted. Please rebuild the frontend." });
  }
});

// Analyze endpoint
app.post("/api/analyze", upload.array("files", 50), async (req, res) => {
  let tempDir = null;
  try {
    const uploadType = req.body.uploadType;
    if (!uploadType) throw new Error("Upload type not specified");

    tempDir = path.join(__dirname, "Uploads", `temp_${Date.now()}`);
    await fsPromises.mkdir(tempDir, { recursive: true });

    let csprojPath;
    let projectFiles = [];
    if (uploadType === "zip") {
      if (!req.files || req.files.length !== 1 || !req.files[0].originalname.endsWith(".zip")) {
        throw new Error("Invalid ZIP file: Please upload a single .zip file");
      }
      const zipPath = req.files[0].path;
      await new Promise((resolve, reject) => {
        fs.createReadStream(zipPath)
          .pipe(unzipper.Extract({ path: tempDir }))
          .on("close", resolve)
          .on("error", reject);
      });
      await walkDir(tempDir);
      const csprojFiles = projectFiles.filter((file) => file.endsWith(".csproj"));
      if (!csprojFiles.length) throw new Error("No .csproj file found in ZIP");
      csprojPath = csprojFiles[0];
      await fsPromises.unlink(zipPath).catch((err) => console.warn("Failed to delete ZIP:", err));
    } else if (uploadType === "files") {
      if (!req.files.length) throw new Error("No files uploaded");
      const csprojFiles = req.files.filter((f) => f.originalname.endsWith(".csproj"));
      if (!csprojFiles.length) throw new Error("No .csproj file uploaded");
      for (const file of req.files) {
        const destPath = path.join(tempDir, file.originalname);
        await fsPromises.copyFile(file.path, destPath);
        projectFiles.push(destPath);
        await fsPromises.unlink(file.path).catch((err) => console.warn(`Failed to delete ${file.path}:`, err));
      }
      csprojPath = path.join(tempDir, csprojFiles[0].originalname);
    } else {
      throw new Error("Invalid upload type");
    }

    const analyzerPath = path.join(__dirname, "..", "analyzer", "analyzer", "bin", "Debug", "net9.0", "win-x64", "analyzer.exe");
    if (!(await fsPromises.access(analyzerPath).then(() => true).catch(() => false))) {
      throw new Error(`Analyzer executable not found at ${analyzerPath}`);
    }

    const command = `"${analyzerPath}" "${csprojPath}"`;
    const content = await fsPromises.readFile(csprojPath, "utf-8");
    const targetFramework = content.match(/<TargetFramework>(.*?)<\/TargetFramework>/i)?.[1] || "Unknown";
    const dependencies = content.match(/<PackageReference Include="(.*?)"\s*Version="/gi)?.map((dep) => dep.match(/Include="(.*?)"\s*/i)[1]) || [];

    const report = {
      targetFramework,
      dependencies,
      issues: targetFramework !== "net48" ? ["Expected .NET Framework 4.8 (net48)."] : [],
      genAiSuggestions: [],
      originalCode: {},
      roslynOutput: "",
      MigratedFiles: {},
      ProjectStructure: [],
      SemanticGraph: [], // Placeholder for Neo4j data if provided by analyzer
      tempDir,
    };

    if (dependencies.includes("System.Web")) {
      report.issues.push("System.Web is incompatible with .NET 9.0.");
    }

    const { stdout, stderr } = await new Promise((resolve, reject) => {
      exec(command, { windowsHide: true }, (error, stdout, stderr) => {
        if (error) reject({ error, stdout, stderr });
        else resolve({ stdout, stderr });
      });
    });

    console.log("Analyzer Output:", { stdout, stderr });
    if (stderr) {
      report.roslynOutput = `Analyzer error: ${stderr}`;
    } else {
      try {
        const analysis = JSON.parse(stdout);
        if (analysis.SyntaxTreeData) {
          analysis.SyntaxTreeData.forEach((node) => {
            if (node.Issues && node.Issues.length > 0) {
              const fileContent = fs.readFileSync(node.FilePath, "utf-8");
              report.originalCode[node.FilePath] = fileContent;
            }
          });
        }
        report.MigratedFiles = analysis.MigratedFiles || {};
        report.ProjectStructure = analysis.ProjectStructure || [];
        report.SemanticGraph = analysis.SemanticGraph || []; // Ensure SemanticGraph is included
      } catch (e) {
        report.roslynOutput = `Parse error: ${e.message}\n${stdout}`;
        report.originalCode = { error: report.roslynOutput };
        report.MigratedFiles = {};
        report.ProjectStructure = [];
        report.SemanticGraph = [];
      }
    }

    res.json(report);
  } catch (error) {
    console.error("Analysis Error:", error);
    res.status(500).json({ error: error.message });
  } finally {
    if (tempDir && fs.existsSync(tempDir)) {
      fsPromises.rm(tempDir, { recursive: true, force: true }).catch((err) =>
        console.warn("Failed to clean up temp directory:", err)
      );
    }
  }
});

// Migrate endpoint
app.post("/api/migrate", upload.none(), async (req, res) => {
  const { filePath, migratedCode } = req.body;
  try {
    if (!filePath || !migratedCode) throw new Error("Missing filePath or migratedCode");
    const fullPath = path.join(process.cwd(), "Uploads", filePath);
    if (!fs.existsSync(fullPath)) throw new Error("File not found for migration");
    await fsPromises.writeFile(fullPath, migratedCode);
    res.json({ success: true, message: "File migrated successfully" });
  } catch (error) {
    console.error("Migration Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Download endpoint
app.post("/api/download", upload.none(), async (req, res) => {
  const { tempDir, MigratedFiles } = req.body;
  try {
    if (!tempDir || !MigratedFiles || Object.keys(MigratedFiles).length === 0) {
      throw new Error("Invalid or missing migration data");
    }

    const zip = new AdmZip();
    for (const [filePath, data] of Object.entries(MigratedFiles)) {
      const relativePath = path.basename(filePath); // Use basename to avoid path issues
      zip.addFile(relativePath, Buffer.from(data.Migrated || data.Original || ""));
    }

    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", "attachment; filename=migrated_project.zip");
    res.send(zip.toBuffer());

    // Clean up temp directory after successful download
    if (fs.existsSync(tempDir)) {
      await fsPromises.rm(tempDir, { recursive: true, force: true }).catch((err) =>
        console.warn("Failed to clean up temp directory:", err)
      );
    }
  } catch (error) {
    console.error("Download Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3001, () => {
  console.log("Backend running on http://localhost:3001");
});

// Utility function to walk directory
async function walkDir(dir) {
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(fullPath);
    } else {
      projectFiles.push(fullPath);
    }
  }
}