@echo off
chcp 65001 >nul 2>&1
setlocal EnableDelayedExpansion

:: ============================================================
::  Memolo — One-Command Setup (Windows)
::  Usage: Double-click or run: setup.bat
:: ============================================================

echo.
echo   ╔══════════════════════════════════════╗
echo   ║     🧠 Memolo Memory System Setup    ║
echo   ║     One-Command Installation         ║
echo   ╚══════════════════════════════════════╝
echo.

:: ============ CHECK ADMIN ============
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo ⚠️  Some features may need admin rights. Consider running as Administrator.
    echo.
)

:: ============ STEP 1: DOCKER ============
echo ━━━ Step 1/6: Checking Docker ━━━
echo.

where docker >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Docker not found!
    echo.
    echo    Please install Docker Desktop from:
    echo    https://www.docker.com/products/docker-desktop/
    echo.
    echo    After installing, restart this script.
    echo.
    
    :: Try winget install
    where winget >nul 2>&1
    if %errorlevel% equ 0 (
        echo    Or install via winget:
        set /p INSTALL_DOCKER="   Install Docker via winget now? [y/N]: "
        if /i "!INSTALL_DOCKER!"=="y" (
            winget install -e --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements
            echo.
            echo ✅ Docker Desktop installed. Please start Docker Desktop, then re-run this script.
            pause
            exit /b 0
        )
    )
    pause
    exit /b 1
) else (
    for /f "tokens=*" %%a in ('docker --version 2^>nul') do echo ✅ %%a
)

:: Check Docker is running
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo ⚠️  Docker is installed but not running. Please start Docker Desktop.
    echo    Waiting for Docker to start...
    :WAIT_DOCKER
    timeout /t 5 /nobreak >nul
    docker info >nul 2>&1
    if %errorlevel% neq 0 goto WAIT_DOCKER
    echo ✅ Docker is running!
)

echo.

:: ============ STEP 2: LLM PROVIDER ============
echo ━━━ Step 2/6: LLM Provider Configuration ━━━
echo.
echo   Choose your LLM provider:
echo.
echo     1) MiniMax (Cloud) — recommended, fast, cheap
echo        Requires: API key from https://platform.minimax.io
echo.
echo     2) Ollama (Local) — free, private, needs GPU (8GB+ VRAM)
echo        Will auto-install Ollama + download models (~8GB)
echo.
echo     3) Both — MiniMax primary, Ollama fallback
echo.

set LLM_CHOICE=1
set /p LLM_CHOICE="  Enter choice [1/2/3] (default: 1): "

set MINIMAX_KEY=
set INSTALL_OLLAMA=0
set LLM_PROVIDER=minimax

if "%LLM_CHOICE%"=="2" (
    set LLM_PROVIDER=ollama
    set INSTALL_OLLAMA=1
) else if "%LLM_CHOICE%"=="3" (
    set LLM_PROVIDER=minimax
    set INSTALL_OLLAMA=1
)

if "%LLM_CHOICE%"=="1" goto GET_MINIMAX
if "%LLM_CHOICE%"=="3" goto GET_MINIMAX
goto SKIP_MINIMAX

:GET_MINIMAX
set /p MINIMAX_KEY="  Enter your MiniMax API key (or press Enter to skip): "
if "!MINIMAX_KEY!"=="" set MINIMAX_KEY=your-minimax-api-key-here

:SKIP_MINIMAX
echo.

:: ============ STEP 3: OLLAMA ============
if %INSTALL_OLLAMA%==1 (
    echo ━━━ Step 3/6: Setting up Ollama ━━━
    echo.
    
    where ollama >nul 2>&1
    if %errorlevel% neq 0 (
        echo ⚠️  Ollama not found. Installing...
        
        where winget >nul 2>&1
        if %errorlevel% equ 0 (
            winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements
            echo ✅ Ollama installed
        ) else (
            echo ❌ Please install Ollama from https://ollama.com/download
            echo    Then re-run this script.
            pause
            exit /b 1
        )
    ) else (
        echo ✅ Ollama found
    )
    
    :: Start Ollama
    echo ℹ️  Starting Ollama service...
    start /min "" ollama serve 2>nul
    timeout /t 3 /nobreak >nul
    
    :: Pull models
    echo ℹ️  Pulling embedding model (qwen3-embedding:8b)...
    ollama pull qwen3-embedding:8b
    echo ✅ Embedding model ready
    
    echo ℹ️  Pulling chat model (qwen2.5:7b)...
    ollama pull qwen2.5:7b
    echo ✅ Chat model ready
) else (
    echo ━━━ Step 3/6: Ollama (skipped — using MiniMax cloud) ━━━
)
echo.

:: ============ STEP 4: GENERATE .ENV ============
echo ━━━ Step 4/6: Generating configuration ━━━
echo.

:: Generate random master key
set "CHARS=abcdef0123456789"
set "MASTER_KEY="
for /L %%i in (1,1,32) do (
    set /a "idx=!random! %% 16"
    for %%j in (!idx!) do set "MASTER_KEY=!MASTER_KEY!!CHARS:~%%j,1!"
)

:: Generate random PG password
set "PG_PASS="
for /L %%i in (1,1,16) do (
    set /a "idx=!random! %% 16"
    for %%j in (!idx!) do set "PG_PASS=!PG_PASS!!CHARS:~%%j,1!"
)

if exist .env (
    echo ⚠️  .env already exists — backing up to .env.backup
    copy .env .env.backup >nul
)

(
echo # Memolo — Auto-generated Configuration
echo # Generated: %date% %time%
echo.
echo LLM_PROVIDER=!LLM_PROVIDER!
echo.
echo MINIMAX_API_KEY=!MINIMAX_KEY!
echo MINIMAX_MODEL=MiniMax-M2.5
echo MINIMAX_BASE_URL=https://api.minimax.io/anthropic/v1/messages
echo.
echo OLLAMA_BASE_URL=http://host.docker.internal:11434
echo OLLAMA_EMBED_MODEL=qwen3-embedding:8b
echo OLLAMA_CHAT_MODEL=qwen2.5:7b
echo OLLAMA_TIMEOUT=180000
echo.
echo MEMOLO_MASTER_KEY=!MASTER_KEY!
echo PORT=7437
echo.
echo PG_USER=openclaw
echo PG_PASSWORD=!PG_PASS!
echo PG_DATABASE=openclaw_memory
echo.
echo SUMMARIZE_AFTER_EXCHANGES=5
echo EMBEDDING_DIMENSIONS=4096
) > .env

echo ✅ .env created with secure random keys
echo.

:: ============ STEP 5: BUILD & START ============
echo ━━━ Step 5/6: Building and starting services ━━━
echo.
echo ℹ️  First time may take 2-5 minutes...
echo.

docker compose up -d --build

echo.
echo ℹ️  Waiting for services to start...

:: Wait for health check
set RETRY=0
:HEALTH_CHECK
timeout /t 2 /nobreak >nul
curl -s http://localhost:7437/api/health >nul 2>&1
if %errorlevel% equ 0 goto HEALTH_OK
set /a RETRY+=1
if %RETRY% lss 30 goto HEALTH_CHECK
echo ⚠️  Server still starting... check: docker compose logs memolo
goto STEP6

:HEALTH_OK
echo ✅ All services running!
echo.

:: ============ STEP 6: VERIFY ============
:STEP6
echo ━━━ Step 6/6: Verification ━━━
echo.

curl -s http://localhost:7437/api/health | findstr "ok" >nul 2>&1
if %errorlevel% equ 0 (
    echo ✅ Memolo API      → http://localhost:7437
) else (
    echo ⚠️  Memolo API      → starting...
)

docker exec memolo-postgres pg_isready -U openclaw >nul 2>&1
if %errorlevel% equ 0 (
    echo ✅ PostgreSQL      → running
) else (
    echo ⚠️  PostgreSQL      → starting...
)

echo.
echo   ╔══════════════════════════════════════╗
echo   ║     🎉 Memolo Setup Complete!        ║
echo   ╚══════════════════════════════════════╝
echo.
echo   Dashboard:    http://localhost:7437
echo   Master Key:   !MASTER_KEY:~0,16!... (saved in .env)
echo.
echo   Commands:
echo     docker compose logs -f memolo    View logs
echo     docker compose restart memolo    Restart
echo     docker compose down              Stop all
echo.

if "!MINIMAX_KEY!"=="your-minimax-api-key-here" (
    echo   ⚠️  Don't forget to add your MiniMax API key in .env!
    echo.
)

:: Open browser
start http://localhost:7437 2>nul

pause
