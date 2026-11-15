"""Make a viewing copy of a screenshot: 1600 wide JPG (the image viewer posterizes full-size PNGs),
or a 1:1 crop with --kirp x,y,w,h."""
import sys
from PIL import Image

src = sys.argv[1]
im = Image.open(src).convert("RGB")
if "--kirp" in sys.argv:
    x, y, w, h = map(int, sys.argv[sys.argv.index("--kirp") + 1].split(","))
    im = im.crop((x, y, x + w, y + h))
    out = src.replace(".png", f"_kirp{x}_{y}.jpg")
else:
    im = im.resize((1600, round(im.height * 1600 / im.width)), Image.LANCZOS)
    out = src.replace(".png", "_k.jpg")
im.save(out, quality=92)
print(out)
