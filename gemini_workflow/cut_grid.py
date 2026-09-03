"""
gemini_workflow/cut_grid.py -- cut one image into a cols x rows grid by hand.

GUI mode (default): opens the image and lets you DRAG the column/row divider
lines onto the real panel borders (they start evenly spaced), then export
every cell to a folder. Use this when a generated character sheet is not
pixel-perfect, so the slices land on the actual gutters instead of a blind
even split.

    cut_grid.bat [--image IMG] [--cols N] [--rows M] [--out DIR] [--trim P]

      --image    image to cut (omitted -> a file dialog opens)
      --cols / --rows   starting grid (spin boxes change it live)
      --out      output folder (default: <image dir>/<stem>_cut)
      --trim     px trimmed from every cell border before saving (default 0)

    Drag: press near a red line and move it. Buttons: Open, Reset, Export.

Headless mode (no GUI, plain even cut):
    cut_grid.bat --image IMG --cols 3 --rows 2 --out DIR --nogui [--trim 8]

Tiles are saved as <stem>_r<row>c<col>.png in the output folder.
"""
import argparse
import os
import sys

_DISPLAY_AREA = (1100, 800)   # max px the image is scaled to fit in the GUI
_HIT_PX = 12                  # how close a click must be to a line to grab it


# ---------------------------------------------------------------------------
# Core cutting logic (no GUI) - shared by the GUI and the headless path
# ---------------------------------------------------------------------------
class GridCutter:
    """Divider lines live as fractions (0..1) of the image, so a GUI drag
    maps straight to original-image coordinates through one uniform scale."""

    def __init__(self, path: str, cols: int = 3, rows: int = 2):
        from PIL import Image
        self.path = path
        self.img = Image.open(path)
        self.img.load()
        self.w, self.h = self.img.size
        self.cols = self.rows = 0
        self.vfracs = []   # vertical dividers, len cols-1
        self.hfracs = []   # horizontal dividers, len rows-1
        self.set_grid(cols, rows)

    def set_grid(self, cols: int, rows: int):
        cols, rows = max(1, int(cols)), max(1, int(rows))
        if cols == self.cols and rows == self.rows:
            return
        old_v, old_h = self.vfracs, self.hfracs
        self.cols, self.rows = cols, rows
        # keep dividers that still fit, fill the rest evenly
        self.vfracs = [old_v[i] if i < len(old_v) and old_v[i] > 0
                       else (i + 1) / cols for i in range(cols - 1)]
        self.hfracs = [old_h[i] if i < len(old_h) and old_h[i] > 0
                       else (i + 1) / rows for i in range(rows - 1)]

    @staticmethod
    def _stops(fracs, size):
        pts = sorted({int(round(f * size)) for f in fracs})
        return [0] + [p for p in pts if 0 < p < size] + [size]

    def export(self, out_dir: str, trim: int = 0):
        """Crop every cell and save <stem>_r<row>c<col>.png. Returns paths."""
        os.makedirs(out_dir, exist_ok=True)
        x = self._stops(self.vfracs, self.w)
        y = self._stops(self.hfracs, self.h)
        trim = max(0, int(trim))
        stem = os.path.splitext(os.path.basename(self.path))[0]
        saved = []
        for r in range(len(y) - 1):
            for c in range(len(x) - 1):
                x0, y0 = x[c] + trim, y[r] + trim
                x1, y1 = x[c + 1] - trim, y[r + 1] - trim
                if x1 - x0 <= 0 or y1 - y0 <= 0:
                    continue
                tile = self.img.crop((max(0, x0), max(0, y0),
                                      min(self.w, x1), min(self.h, y1)))
                out = os.path.join(out_dir,
                                   f"{stem}_r{r + 1:02d}c{c + 1:02d}.png")
                tile.save(out, format="PNG")
                saved.append(out)
        return saved


# ---------------------------------------------------------------------------
# GUI
# ---------------------------------------------------------------------------
def _run_gui(cutter: GridCutter, args) -> int:
    import tkinter as tk
    from tkinter import filedialog, messagebox
    from PIL import Image, ImageTk

    class App(tk.Tk):
        def __init__(self):
            super().__init__()
            self.title(f"Cut grid - {os.path.basename(cutter.path)}")
            self.resizable(False, False)
            self.cutter = cutter
            self.out_default = args.out

            self.canvas = tk.Canvas(self, bg="#303030", highlightthickness=0)
            self.canvas.pack()

            bar = tk.Frame(self)
            bar.pack(fill="x", padx=6, pady=4)
            tk.Label(bar, text="Cols").pack(side="left")
            self.cols_var = tk.IntVar(value=cutter.cols)
            tk.Spinbox(bar, from_=1, to=24, width=4, textvariable=self.cols_var,
                       command=self._apply_grid).pack(side="left", padx=(2, 8))
            tk.Label(bar, text="Rows").pack(side="left")
            self.rows_var = tk.IntVar(value=cutter.rows)
            tk.Spinbox(bar, from_=1, to=24, width=4, textvariable=self.rows_var,
                       command=self._apply_grid).pack(side="left", padx=(2, 8))
            tk.Label(bar, text="Trim px").pack(side="left", padx=(8, 2))
            self.trim_var = tk.StringVar(value=str(args.trim))
            tk.Entry(bar, width=5, textvariable=self.trim_var).pack(side="left")
            tk.Label(bar, text="Out:").pack(side="left", padx=(8, 2))
            self.out_var = tk.StringVar(value=self.out_default)
            tk.Entry(bar, width=34, textvariable=self.out_var).pack(side="left")
            for text, cmd in (("Open", self._open), ("Reset", self._reset),
                              ("Export", self._export)):
                tk.Button(bar, text=text, command=cmd).pack(side="right", padx=2)

            self.status = tk.Label(self, anchor="w", text="", fg="#666")
            self.status.pack(fill="x", padx=6, pady=(0, 4))

            self.photo = None
            self.drag = None
            self._reload(preview_only=True)
            self.canvas.bind("<Button-1>", self._on_press)
            self.canvas.bind("<B1-Motion>", self._on_drag)
            self.canvas.bind("<ButtonRelease-1>", lambda e: setattr(self,
                              "drag", None))

        # --- display sizing / drawing ---
        def _reload(self, preview_only=False):
            c = self.cutter
            scale = min(_DISPLAY_AREA[0] / c.w, _DISPLAY_AREA[1] / c.h, 1.0)
            self.dw, self.dh = int(c.w * scale), int(c.h * scale)
            self.scale = scale
            preview = c.img.convert("RGB").resize(
                (self.dw, self.dh), Image.Resampling.LANCZOS)
            self.photo = ImageTk.PhotoImage(preview)
            self.canvas.config(width=self.dw, height=self.dh)
            self._redraw()

        def _redraw(self):
            c = self.cutter
            self.canvas.delete("all")
            self.canvas.create_image(0, 0, image=self.photo, anchor="nw")
            for f in c.vfracs:
                x = f * self.dw
                self.canvas.create_line(x, 0, x, self.dh,
                                        fill="#ff2b2b", width=2)
            for f in c.hfracs:
                y = f * self.dh
                self.canvas.create_line(0, y, self.dw, y,
                                        fill="#ff2b2b", width=2)
            self.status.config(
                text=f"{c.cols} x {c.rows} = {c.cols * c.rows} cells - "
                     f"drag the red lines onto the panel borders")

        # --- controls ---
        def _apply_grid(self):
            try:
                self.cutter.set_grid(max(1, self.cols_var.get()),
                                     max(1, self.rows_var.get()))
            except tk.TclError:
                return
            self._redraw()

        def _reset(self):
            c = self.cutter
            c.vfracs = [(i + 1) / c.cols for i in range(c.cols - 1)]
            c.hfracs = [(i + 1) / c.rows for i in range(c.rows - 1)]
            self._redraw()

        def _open(self):
            path = filedialog.askopenfilename(
                title="Open image", parent=self,
                filetypes=[("Images", "*.png *.jpg *.jpeg *.webp *.bmp"),
                           ("All files", "*.*")])
            if not path:
                return
            try:
                new_cut = GridCutter(path, self.cutter.cols, self.cutter.rows)
            except Exception as exc:  # noqa: BLE001
                messagebox.showerror("Cannot open", str(exc), parent=self)
                return
            self.cutter = new_cut
            self.title(f"Cut grid - {os.path.basename(path)}")
            self.out_var.set(self.out_default)
            self._reload()

        # --- dragging ---
        def _nearest(self, x, y):
            best, kind = None, None
            for i, f in enumerate(self.cutter.vfracs):
                d = abs(x - f * self.dw)
                if d < _HIT_PX and (best is None or d < best[0]):
                    best, kind = (d, i), "v"
            for j, f in enumerate(self.cutter.hfracs):
                d = abs(y - f * self.dh)
                if d < _HIT_PX and (best is None or d < best[0]):
                    best, kind = (d, j), "h"
            return best, kind

        def _on_press(self, ev):
            hit, kind = self._nearest(ev.x, ev.y)
            self.drag = (kind, hit) if hit else None

        def _on_drag(self, ev):
            if not self.drag:
                return
            kind, (_, i) = self.drag
            fracs = self.cutter.vfracs if kind == "v" else self.cutter.hfracs
            size = self.dw if kind == "v" else self.dh
            pos = ev.x if kind == "v" else ev.y
            lo = 0 if i == 0 else fracs[i - 1] + 0.004
            hi = 1 if i == len(fracs) - 1 else fracs[i + 1] - 0.004
            fracs[i] = min(max(pos / size, lo), hi)
            self._redraw()

        def _export(self):
            try:
                trim = int(self.trim_var.get())
            except ValueError:
                trim = 0
            out_dir = self.out_var.get().strip() or self.out_default
            try:
                saved = self.cutter.export(out_dir, trim)
            except Exception as exc:  # noqa: BLE001
                messagebox.showerror("Export failed", str(exc), parent=self)
                return
            self.status.config(text=f"Exported {len(saved)} tiles -> {out_dir}")
            messagebox.showinfo("Done",
                                f"Exported {len(saved)} tiles to:\n{out_dir}",
                                parent=self)

    app = App()
    app.mainloop()
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(
        description="Cut an image into a cols x rows grid by hand (GUI), or "
                    "evenly with --nogui.")
    ap.add_argument("--image", default="",
                    help="Image file to cut (GUI opens a dialog if omitted).")
    ap.add_argument("--cols", type=int, default=3, help="Columns (default 3).")
    ap.add_argument("--rows", type=int, default=2, help="Rows (default 2).")
    ap.add_argument("--out", default="",
                    help="Output folder (default: <image dir>/<stem>_cut).")
    ap.add_argument("--trim", type=int, default=0,
                    help="px trimmed from every cell border (default 0).")
    ap.add_argument("--nogui", action="store_true",
                    help="Headless: plain even cut, no GUI.")
    args = ap.parse_args()

    if not args.image:
        if args.nogui:
            print("cut_grid: --image is required in --nogui mode")
            return 2
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        args.image = filedialog.askopenfilename(
            title="Open image to cut",
            filetypes=[("Images", "*.png *.jpg *.jpeg *.webp *.bmp"),
                       ("All files", "*.*")])
        root.destroy()
        if not args.image:
            return 0

    if not os.path.isfile(args.image):
        print(f"cut_grid: image not found: {args.image}")
        return 2
    if args.cols < 1 or args.rows < 1:
        print("cut_grid: --cols and --rows must be >= 1")
        return 2

    out = args.out or os.path.join(
        os.path.dirname(os.path.abspath(args.image)) or ".",
        os.path.splitext(os.path.basename(args.image))[0] + "_cut")

    try:
        cutter = GridCutter(args.image, args.cols, args.rows)
    except Exception as exc:  # noqa: BLE001
        print(f"cut_grid: cannot open image: {exc}")
        return 1

    if args.nogui:
        saved = cutter.export(out, args.trim)
        print(f"cut_grid: {len(saved)} tiles -> {out}")
        for s in saved:
            print(f"  {s}")
        return 0

    return _run_gui(cutter, args)


if __name__ == "__main__":
    sys.exit(main())
