@echo off
chcp 65001 >nul
title ModelSpace Frontend
echo ============================================
echo   ModelSpace 前端开发服务启动
echo   地址: http://localhost:5173
echo ============================================
echo.

REM 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Node.js，请先安装 Node.js 22.12+ 或 24+
    pause
    exit /b 1
)

REM 检查 node_modules
if not exist "node_modules" (
    echo [信息] 未找到 node_modules，正在安装依赖...
    call npm ci --registry=https://registry.npmjs.org
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败。
        pause
        exit /b 1
    )
)

REM 检查端口是否已被占用
netstat -ano | findstr ":5173 " | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo [警告] 端口 5173 已被占用，可能已有服务在运行。
    echo         如需重启，请先运行 stop.cmd
    pause
    exit /b 1
)

echo [启动] 正在启动前端开发服务...
echo.
call npm run dev
