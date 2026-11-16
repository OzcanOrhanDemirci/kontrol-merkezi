"""Look for a regular pattern (banding, grid) in a dark region of a screenshot: column and row
means, their spread, and the strongest period in the column means."""
import sys
import numpy as np
from PIL import Image

im = np.asarray(Image.open(sys.argv[1]).convert("RGB"), dtype=np.float32)
x, y, w, h = map(int, sys.argv[2].split(","))
r = im[y:y + h, x:x + w].mean(axis=2)
print("mean level", round(float(r.mean()), 2), "min", r.min(), "max", r.max())
cm = r.mean(axis=0) - r.mean()
rm = r.mean(axis=1) - r.mean()
print("column-mean spread", round(float(cm.std()), 3), "row-mean spread", round(float(rm.std()), 3))
f = np.abs(np.fft.rfft(cm - np.convolve(cm, np.ones(31) / 31, mode="same")))
k = int(np.argmax(f[2:])) + 2
print("strongest column period", round(w / k, 2), "px, amplitude", round(float(f[k] / len(cm) * 2), 3))
vals, counts = np.unique(np.round(r).astype(int), return_counts=True)
print("levels", dict(zip(vals.tolist()[:12], counts.tolist()[:12])))
