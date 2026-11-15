"""Probe: does headless Edge give a real-GPU WebGL2 context with the extensions the window needs?"""
from playwright.sync_api import sync_playwright

EDGE = r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
ARGS = ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"]

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=EDGE, headless=True, args=ARGS)
    pg = b.new_page()
    print(pg.evaluate("""() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return 'no webgl2';
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      const ext = ['EXT_disjoint_timer_query_webgl2', 'KHR_parallel_shader_compile', 'EXT_color_buffer_float', 'EXT_float_blend'];
      return [gl.getParameter(d.UNMASKED_RENDERER_WEBGL), ...ext.map(e => e + '=' + !!gl.getExtension(e)),
              'uniformVec=' + gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS)].join('\\n');
    }"""))
    b.close()
