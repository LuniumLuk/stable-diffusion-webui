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

set TORCH_COMMAND=pip install torch==2.11.0+cu128 torchvision==0.26.0+cu128 torchaudio==2.11.0+cu128 --index-url https://download.pytorch.org/whl/cu128
set COMMANDLINE_ARGS=

call webui.bat
