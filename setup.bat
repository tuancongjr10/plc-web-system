@echo off
echo ==========================================
echo PLC WEB CONTROL SYSTEM - SETUP SCRIPT
echo ==========================================
echo.

node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please download and install Node.js from https://nodejs.org/
    pause
    exit /b
)

echo [1/3] Installing Backend Dependencies...
cd backend
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install backend dependencies!
    pause
    exit /b
)

echo.
echo [2/3] Installing Frontend Dependencies...
cd ..\frontend
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install frontend dependencies!
    pause
    exit /b
)

echo.
echo [3/3] Initializing Database...
cd ..\backend
call npm run db:init

echo.
echo ==========================================
echo Setup Completed Successfully!
echo ==========================================
echo To start the system:
echo 1. Open a terminal in the 'backend' folder and run: npm run dev
echo 2. Open a terminal in the 'frontend' folder and run: npm run dev
echo.
pause
