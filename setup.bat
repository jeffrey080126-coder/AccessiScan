@echo off
REM Quick Setup Script for AccessiScan (Windows)

echo 🚀 AccessiScan Setup
echo ====================

REM Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ❌ Node.js is not installed. Please install it from https://nodejs.org/
    exit /b 1
)

echo ✅ Node.js found: 
node --version

REM Install dependencies
echo.
echo 📦 Installing dependencies...
call npm install

REM Create .env file
if not exist .env (
    echo.
    echo 📝 Creating .env file...
    copy .env.example .env
    echo ✅ .env created. You can add Claude API key later if needed.
)

echo.
echo 🎉 Setup complete!
echo.
echo To start the scanner, run:
echo   npm start
echo.
echo Then open: http://localhost:3000
echo.
pause
