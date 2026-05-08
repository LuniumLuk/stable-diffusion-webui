@echo off

set PYTHON=C:\Users\luniu\.pyenv\pyenv-win\versions\3.10.6\python.exe
set GIT=
set VENV_DIR=%~dp0.venv

set INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
set PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
set PIP_TRUSTED_HOST=pypi.tuna.tsinghua.edu.cn

set HF_ENDPOINT=https://hf-mirror.com

set STABLE_DIFFUSION_REPO=https://github.com/CompVis/stable-diffusion.git
set STABLE_DIFFUSION_COMMIT_HASH=21f890f9da3cfbeaba8e2ac3c425ee9e998d5229

set PYTHONPATH=%~dp0repositories\taming-transformers;%PYTHONPATH%
set AUTH_FILE=%~dp0webui-auth.txt
set OUTPUTS_DIR=%~dp0outputs
set LOG_DIR=%~dp0log
set CACHE_DIR=%~dp0cache

set TORCH_COMMAND=pip install torch==2.11.0+cu128 torchvision==0.26.0+cu128 torchaudio==2.11.0+cu128 --index-url https://download.pytorch.org/whl/cu128
set COMMANDLINE_ARGS=--listen --server-name 0.0.0.0 --gradio-auth-path "%AUTH_FILE%" --gradio-allowed-path "%OUTPUTS_DIR%" --gradio-allowed-path "%LOG_DIR%" --gradio-allowed-path "%CACHE_DIR%" --theme dark --timeout 600 --timeout-keep-alive 120 --no-gradio-queue

rem Avoid localhost startup checks going through external proxy settings.
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
set http_proxy=
set https_proxy=
set all_proxy=
set NO_PROXY=localhost,127.0.0.1,0.0.0.0,::1
set no_proxy=localhost,127.0.0.1,0.0.0.0,::1

call webui.bat
