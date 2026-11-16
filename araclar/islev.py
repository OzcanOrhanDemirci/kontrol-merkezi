"""Functional check of the window's controls in the simulated service: real mouse clicks on the
fan modules and the toggle, Tab / arrows / Space, Esc, and what the page sends to the host."""
import json
import time
from playwright.sync_api import sync_playwright
from olc import open_page

with sync_playwright() as p:
    b, pg, logs, first = open_page(p, 2560, 1440)
    pg.evaluate("""() => { window.__sent = []; const s = __km.sim.send; __km.sim.send = m => { __sent.push(JSON.stringify(m)); s(m); }; }""")
    st = lambda: pg.evaluate("() => ({ kasa: __km.sim.S.kasa.durum, gpu: __km.sim.S.gpuF.durum, rgb: __km.sim.S.rgb, tab: __km.M.tab, focus: __km.M.focus })")
    time.sleep(2)
    print("start", st())
    r = pg.evaluate("() => { const e = document.querySelector('#hotKasa').getBoundingClientRect(); return [e.left + e.width / 2, e.top + e.height / 2]; }")
    pg.mouse.click(*r); time.sleep(0.3); print("click kasa", st())
    time.sleep(2.0); print("after 2 s", st())
    pg.keyboard.press("ArrowRight"); pg.keyboard.press("Space"); time.sleep(0.3); print("right + space", st())
    pg.keyboard.press("Tab"); time.sleep(2.0); print("tab", st())
    r = pg.evaluate("() => { const e = document.querySelector('#hotTog').getBoundingClientRect(); return [e.left + e.width / 2, e.top + e.height / 2, e.width]; }")
    pg.mouse.click(r[0], r[1]); time.sleep(0.6); print("click toggle", st(), "toggle width px", round(r[2]))
    pg.keyboard.press("Enter"); time.sleep(0.6); print("enter", st())
    pg.keyboard.press("ArrowLeft"); time.sleep(2.0); print("left", st())
    pg.keyboard.press("e"); time.sleep(0.5)
    pg.keyboard.press("Space"); time.sleep(0.5); print("no admin + space", st())
    print("sent", pg.evaluate("__sent"))
    print("texts", pg.evaluate("() => [document.querySelector('#mKasa').innerText, document.querySelector('#banner').innerText]"))
    for l in logs:
        print(l)
    b.close()
