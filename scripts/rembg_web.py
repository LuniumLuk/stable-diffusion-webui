import argparse
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, Response
from rembg import remove
import uvicorn


app = FastAPI(title="rembg simple web")


HTML_PAGE = """<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\" />
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
  <title>rembg web wrapper</title>
  <style>
    :root {
      --bg: #f5f7fb;
      --card: #ffffff;
      --text: #1f2937;
      --muted: #6b7280;
      --accent: #0ea5e9;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Segoe UI, sans-serif;
      background: radial-gradient(circle at 20% 10%, #e0f2fe, var(--bg));
      color: var(--text);
    }
    .wrap {
      max-width: 900px;
      margin: 32px auto;
      padding: 0 16px;
    }
    .card {
      background: var(--card);
      border: 1px solid #e5e7eb;
      border-radius: 14px;
      padding: 20px;
      box-shadow: 0 8px 28px rgba(2, 8, 23, 0.06);
    }
    h1 {
      margin: 0 0 8px 0;
      font-size: 1.4rem;
    }
    p {
      margin: 0 0 16px 0;
      color: var(--muted);
    }
    .row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    button {
      border: 0;
      border-radius: 10px;
      padding: 10px 14px;
      background: var(--accent);
      color: white;
      font-weight: 600;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .status {
      margin-top: 12px;
      color: var(--muted);
      min-height: 1.2em;
    }
    .result {
      margin-top: 18px;
      display: none;
    }
    .result img {
      max-width: 100%;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      background-image: linear-gradient(45deg, #ddd 25%, transparent 25%),
                        linear-gradient(-45deg, #ddd 25%, transparent 25%),
                        linear-gradient(45deg, transparent 75%, #ddd 75%),
                        linear-gradient(-45deg, transparent 75%, #ddd 75%);
      background-size: 20px 20px;
      background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
    }
    .download {
      display: inline-block;
      margin-top: 10px;
      color: #0369a1;
      font-weight: 600;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class=\"wrap\">
    <div class=\"card\">
      <h1>rembg simple web wrapper</h1>
      <p>Upload an image and remove its background locally.</p>
      <div class=\"row\">
        <input id=\"file\" type=\"file\" accept=\"image/*\" />
        <button id=\"run\">Remove background</button>
      </div>
      <div id=\"status\" class=\"status\"></div>
      <div id=\"result\" class=\"result\">
        <img id=\"out\" alt=\"output\" />
        <br />
        <a id=\"download\" class=\"download\" href=\"#\" download=\"output.png\">Download PNG</a>
      </div>
    </div>
  </div>

  <script>
    const fileInput = document.getElementById('file');
    const runBtn = document.getElementById('run');
    const statusEl = document.getElementById('status');
    const resultEl = document.getElementById('result');
    const outImg = document.getElementById('out');
    const downloadEl = document.getElementById('download');

    runBtn.addEventListener('click', async () => {
      const file = fileInput.files[0];
      if (!file) {
        statusEl.textContent = 'Please choose an image file first.';
        return;
      }

      runBtn.disabled = true;
      statusEl.textContent = 'Processing...';
      resultEl.style.display = 'none';

      try {
        const form = new FormData();
        form.append('file', file);
        const resp = await fetch('/api/remove', { method: 'POST', body: form });
        if (!resp.ok) {
          const msg = await resp.text();
          throw new Error(msg || 'Request failed');
        }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        outImg.src = url;
        downloadEl.href = url;
        downloadEl.download = file.name.replace(/\.[^.]+$/, '') + '_nobg.png';
        resultEl.style.display = 'block';
        statusEl.textContent = 'Done.';
      } catch (e) {
        statusEl.textContent = 'Error: ' + e.message;
      } finally {
        runBtn.disabled = false;
      }
    });
  </script>
</body>
</html>
"""


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    return HTML_PAGE


@app.post("/api/remove")
async def remove_background(file: UploadFile = File(...)) -> Response:
    content_type = file.content_type or ""
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image uploads are supported.")

    input_bytes = await file.read()
    if not input_bytes:
        raise HTTPException(status_code=400, detail="Empty file.")

    try:
        output_bytes = remove(input_bytes)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"rembg failed: {exc}") from exc

    filename = (file.filename or "output").rsplit(".", 1)[0] + "_nobg.png"
    headers = {"Content-Disposition": f'inline; filename="{filename}"'}
    return Response(content=output_bytes, media_type="image/png", headers=headers)


def main() -> None:
    parser = argparse.ArgumentParser(description="Simple rembg webpage wrapper")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind")
    parser.add_argument("--port", type=int, default=7862, help="Port to bind")
    args = parser.parse_args()

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
