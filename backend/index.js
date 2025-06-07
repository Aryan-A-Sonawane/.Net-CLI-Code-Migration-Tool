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

const app = express();
const upload = multer({
  dest: "Uploads/",
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.use(cors({ origin: "http://localhost:3000" }));
app.use(express.json());

const staticPath = path.join(__dirname, "../frontend/build");
app.use(express.static(staticPath));

app.get("*", (req, res) => {
  res.sendFile(path.join(staticPath, "index.html"));
});

app.post("/api/analyze", upload.array("files", 50), async (req, res) => {
  let tempDir = null;
  try {
    const uploadType = req.body.uploadType;
    console.log("Upload type:", uploadType);
    if (!uploadType) throw new Error("Upload type not specified");

    tempDir = path.join(__dirname, "Uploads", Date.now().toString());
    await fsPromises.mkdir(tempDir, { recursive: true });
    console.log("Temp dir created:", tempDir);

    let csprojPath;
    if (uploadType === "zip") {
      if (
        !req.files ||
        req.files.length !== 1 ||
        !req.files[0].originalname.endsWith(".zip")
      ) {
        throw new Error("Invalid ZIP file: Please upload a .zip file");
      }

      const zipPath = req.files[0].path;
      console.log("ZIP path:", zipPath);
      await new Promise((resolve, reject) => {
        fs.createReadStream(zipPath)
          .pipe(unzipper.Extract({ path: tempDir }))
          .on("close", () => {
            console.log("ZIP extracted to:", tempDir);
            resolve();
          })
          .on("error", (err) => {
            console.error("ZIP extraction error:", err);
            reject(err);
          });
      });

      const files = [];
      async function walkDir(dir) {
        const entries = await fsPromises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walkDir(fullPath);
          } else {
            files.push(fullPath);
          }
        }
      }
      await walkDir(tempDir);
      console.log("Extracted files:", files);

      const csprojFiles = files.filter((file) => file.endsWith(".csproj"));
      if (!csprojFiles.length)
        throw new Error("No .csproj file found in ZIP: A .csproj is required");
      csprojPath = csprojFiles[0];
      console.log("Found .csproj:", csprojPath);

      await fsPromises
        .unlink(zipPath)
        .catch((err) => console.error("Failed to delete ZIP:", err));
    } else if (uploadType === "files") {
      if (!req.files.length)
        throw new Error("No files uploaded: Please select files");
      const csprojFiles = req.files.filter((f) =>
        f.originalname.endsWith(".csproj")
      );
      if (!csprojFiles.length)
        throw new Error("No .csproj file uploaded: A .csproj is required");

      console.log(
        "Uploaded files:",
        req.files.map((f) => f.originalname)
      );
      for (const file of req.files) {
        const sourcePath = file.path;
        const destPath = path.join(tempDir, file.originalname);
        console.log(`Copying ${sourcePath} to ${destPath}`);
        await fsPromises.copyFile(sourcePath, destPath);
        await fsPromises
          .unlink(sourcePath)
          .catch((err) =>
            console.error(`Failed to delete ${sourcePath}:`, err)
          );
      }
      csprojPath = path.join(tempDir, csprojFiles[0].originalname);
      console.log("Found .csproj:", csprojPath);
    } else {
      throw new Error("Invalid upload type");
    }

    const analyzerPath = path.join(
      __dirname,
      "..",
      "analyzer",
      "analyzer",
      "bin",
      "Debug",
      "net9.0",
      "win-x64",
      "analyzer.exe"
    );
    if (
      !(await fsPromises
        .access(analyzerPath)
        .then(() => true)
        .catch(() => false))
    ) {
      throw new Error(`Analyzer not found at ${analyzerPath}`);
    }
    const command = `"${analyzerPath}" "${csprojPath}"`;

    const content = await fsPromises.readFile(csprojPath, "utf-8");
    const targetFramework =
      content.match(/<TargetFramework>(.*?)<\/TargetFramework>/i)?.[1] ||
      "Unknown";
    const dependencies =
      content
        .match(/<PackageReference Include="(.*?)"\s*Version="/gi)
        ?.map((dep) => dep.match(/Include="(.*?)"\s*/i)[1]) || [];

    const report = {
      targetFramework,
      dependencies,
      issues:
        targetFramework !== "net48"
          ? ["Expected .NET Framework 4.8 (net48)."]
          : [],
      genAiSuggestions: [],
      originalCode: "",
      migratedCode: "",
      roslynOutput: "",
    };

    if (dependencies.includes("System.Web")) {
      report.issues.push("System.Web is incompatible with .NET Core 8.");
    }

    await new Promise((resolve, reject) => {
      exec(command, { windowsHide: true }, (error, stdout, stderr) => {
        console.log("Command:", command);
        console.log("Stdout:", stdout);
        console.log("Stderr:", stderr);
        console.log("Error:", error);

        if (error) {
          report.roslynOutput =
            stderr || `Analyzer execution failed: ${error.message}`;
          resolve();
          return;
        }

        report.roslynOutput = stdout;
        try {
          const analysis = JSON.parse(stdout);
          report.originalCode =
            analysis.DeprecatedApis.length > 0
              ? `using System.Web;\n\npublic class MyClass {\n    public void MyMethod() {\n        var context = ${analysis.DeprecatedApis[0]};\n    }\n}`
              : "// No deprecated APIs found";
        } catch (e) {
          report.originalCode = "// Error parsing Roslyn output";
          report.roslynOutput = `Parse error: ${e.message}\n${stdout}`;
        }
        resolve();
      });
    });

    try {
      const response = await axios.post(
        "https://api.x.ai/v1/chat/completions",
        {
          model: "grok-beta",
          messages: [
            {
              role: "system",
              content:
                "You are a .NET migration expert. Provide refactored .NET Core 8 code.",
            },
            {
              role: "user",
              content: `Refactor for .NET Core 8:\n${
                report.originalCode
              }\nDependencies: ${dependencies.join(", ")}`,
            },
          ],
          max_tokens: 500,
          temperature: 0.7,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.XAI_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      report.genAiSuggestions = response.data.choices[0].message.content
        .split("\n")
        .filter((line) => line.trim());
      report.migratedCode =
        response.data.choices[0].message.content.match(
          /```csharp\n([\s\S]*?)\n```/
        )?.[1] || response.data.choices[0].message.content;
    } catch (apiError) {
      report.genAiSuggestions = [`API error: ${apiError.message}`];
      report.migratedCode = "// Failed to fetch migrated code";
    }

    res.json(report);
    await fsPromises
      .rm(tempDir, { recursive: true, force: true })
      .catch((err) => console.error("Failed to delete temp dir:", err));
    console.log("Temp dir deleted:", tempDir);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: error.message });
    if (req.files) {
      for (const file of req.files) {
        await fsPromises
          .unlink(file.path)
          .catch((err) => console.error("Failed to unlink file:", err.message));
      }
    }
    if (tempDir) {
      await fsPromises
        .rm(tempDir, { recursive: true, force: true })
        .catch((err) => console.error("Failed to delete temp dir:", err));
    }
  }
});

app.listen(3001, () => {
  console.log("Backend running on http://localhost:3001");
});
