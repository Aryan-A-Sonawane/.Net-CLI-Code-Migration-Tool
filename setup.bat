# setup.bat
cd backend
npm install
cd ../frontend
npm install
npm run build
cd ../analyzer
dotnet restore
dotnet build
cd ../backend
node index.js