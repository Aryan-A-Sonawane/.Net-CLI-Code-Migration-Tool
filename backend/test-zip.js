const fs = require("fs"); // Use synchronous fs for createReadStream
const fsPromises = require("fs").promises; // Use promises for async operations
const path = require("path");
const { exec } = require("child_process");
const unzipper = require("unzipper");

async function testZip() {
  try {
    const zipPath = "D:\\z.code\\temp\\Sample.zip";
    const tempDir = path.join(__dirname, "Uploads", Date.now().toString());
    await fsPromises.mkdir(tempDir, { recursive: true });
    console.log("Temp dir created:", tempDir);

    // Extract ZIP
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

    // Find .csproj
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
    if (!csprojFiles.length) throw new Error("No .csproj found in ZIP");
    const csprojPath = csprojFiles[0];
    console.log("Found .csproj:", csprojPath);

    // Run analyzer
    const analyzerPath = path.join(
      __dirname,
      "../analyzer/analyzer/bin/Debug/net9.0/win-x64/analyzer.exe"
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

    await new Promise((resolve, reject) => {
      exec(command, { windowsHide: true }, (error, stdout, stderr) => {
        console.log("Command:", command);
        console.log("Stdout:", stdout);
        console.log("Stderr:", stderr);
        console.log("Error:", error);

        if (error) {
          console.error("Analyzer failed:", stderr || error.message);
          reject(error);
          return;
        }

        try {
          const analysis = JSON.parse(stdout);
          console.log("Parsed analysis:", analysis);
        } catch (e) {
          console.error("Parse error:", e.message, "\nOutput:", stdout);
        }
        resolve();
      });
    });

    // Cleanup
    await fsPromises.rm(tempDir, { recursive: true, force: true });
    console.log("Temp dir removed:", tempDir);
  } catch (error) {
    console.error("Test failed:", error.message);
  }
}

testZip();
