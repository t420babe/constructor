class Framebuffer {
  constructor(gl) {
    this.gl = gl;
    const viewport = gl.getParameter(gl.VIEWPORT);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA,
      viewport[2], viewport[3], 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null
    );
    const fb = gl.createFramebuffer();
    const oldFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, oldFb);
    this.fb = fb;
    this.tex = tex;
    this.viewport = [0, 0, viewport[2], viewport[3]];
  }
  alloc() {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA,
      this.viewport[2], this.viewport[3], 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null
    );
  }
  drawInto(f) {
    const { gl } = this;
    const oldViewport = gl.getParameter(gl.VIEWPORT);
    const oldFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    if (this.viewport[2] != oldViewport[2] || this.viewport[3] != oldViewport[3]) {
      this.viewport = [0, 0, oldViewport[2], oldViewport[3]];
      // Note: other textures are getting stomped here and I don't
      // know why. See the console during a window resize.
      this.alloc();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(...this.viewport);
    f();
    gl.bindFramebuffer(gl.FRAMEBUFFER, oldFb);
    gl.viewport(...oldViewport);
  }
}

class Shader {
  constructor(gl, path, shader, onchange) {
    this.gl = gl;
    this.path = path;
    this.shader = shader;
    this.onchange = onchange;
    this.baseURL = new URL(path, location.href);
    this.interestedPaths = new Set();
    this.changeListener = e => {
      const changedPath = new URL(e.detail, location).pathname;
      if (this.interestedPaths.has(changedPath))
        this.ready = this.reload();
    };
    // window.addEventListener('sourcechange', this.changeListener);
    this.ready = this.reload();
  }
  async reload() {
    const { gl, path, shader } = this;
    this.interestedPaths.clear();
    this.interestedPaths.add(path);
    const text = this.text = await this.loadText(path, this.baseURL);
    gl.shaderSource(shader, text);
    gl.compileShader(shader);
    this.onchange();
  }
  async preprocess(textIn, url) {
    let base = url;
    const directives = {
      includebase: path => {
        base = new URL(path, base);
        return "";
      },
      include: path => {
        const url = new URL(path, base);
        return this.loadText(url.pathname, base)
      }
    };
    let parts = [];
    let hash;
    while ((hash = textIn.indexOf('#')) != -1) {
      const match = textIn.match(/#([a-z]+) "([^"\n]+)"/);
      if (match && (match.index == 0 || textIn[match.index-1] == '\n')) {
        parts.push(textIn.substr(0, match.index));
        parts.push(directives[match[1]](match[2]));
        textIn = textIn.substr(match.index + match[0].length);
      } else {
        parts.push(textIn.substr(0, hash + 1));
        textIn = textIn.substr(hash + 1);
      }
    }
    parts.push(textIn);
    return (await Promise.all(parts)).join('');
  }
  async loadText(path, url) {
    this.interestedPaths.add(path);
    const r = await fetch(path);
    const text = await r.text();
    return await this.preprocess(text, url);
  }
  // destroy() {
  //   window.removeEventListener('sourcechange', this.changeListener);
  // }
}

let sharedCopyProgram;
const getCopyProgram = ctx => {
  if (!sharedCopyProgram) {
    sharedCopyProgram = new ShaderProgram({
      ...ctx,
    }, '/shaders/default.vert', '/shaders/util/copy.frag');
  }
  return sharedCopyProgram;
};

export default class ShaderProgram {
  constructor(ctx, vsPath, fsPath) {
    const gl = this.gl = ctx.canvas.gl;
    this.vsPath = vsPath;
    this.fsPath = fsPath;
    // this.parallelExt = gl.getExtension('GL_KHR_parallel_shader_compile');
    this.interestedPaths = new Set();

    this.uniforms = {
      t: () => ctx.now(),
      u_resolution: () => {
        const { gl } = ctx.canvas;
        const viewport = gl.getParameter(gl.VIEWPORT);
        return [viewport[2], viewport[3]];
      },
      'u_audio.lowpass': () => ctx.lowpass.get(),
      'u_audio.highpass': () => ctx.highpass.get(),
      'u_audio.bandpass': () => ctx.bandpass.get(),
      'u_audio.notch': () => ctx.notch.get(),
      'u_freq_fast': () => ctx.fastFFT.tex,
      'u_freq_med': () => ctx.medFFT.tex,
      'u_freq_slow': () => ctx.slowFFT.tex,
    };

    if (fsPath != '/shaders/util/copy.frag') {
      this.fbs = [
        new Framebuffer(gl),
        new Framebuffer(gl),
      ];
      this.copyProgram = getCopyProgram(ctx);
      this.copyProgram.uniforms.buf = this.fbs[0].tex;
    }

    const buffer = gl.createBuffer();
    this.mesh = new Float32Array([
      -1, 1, 0, -1, -1, 0,
      1, 1, 0, 1, -1, 0,
    ]);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh, gl.STATIC_DRAW);

    this.program = gl.createProgram();

    const onchange = () => this.link();
    this.vs = new Shader(gl, this.vsPath, gl.createShader(gl.VERTEX_SHADER), onchange);
    this.fs = new Shader(gl, this.fsPath, gl.createShader(gl.FRAGMENT_SHADER), onchange);

    gl.attachShader(this.program, this.vs.shader);
    gl.attachShader(this.program, this.fs.shader);
    this.link();
  }
  async link() {
    const { gl } = this;
    this.ready = null;
    this.linking = true;
    await Promise.all([this.vs.ready, this.fs.ready]);
    for (const path of this.vs.interestedPaths)
      this.interestedPaths.add(path);
    for (const path of this.fs.interestedPaths)
      this.interestedPaths.add(path);
    gl.linkProgram(this.program);
    this.linking = false;
  }
  buildUniforms() {
    const { gl, program } = this;
    this.uniformSetters = [];
    let nextTextureNumber = 0;
    for (const k in this.uniforms) {
      const loc = gl.getUniformLocation(program, k);
      if (!loc) {
        // console.info('missing or unused uniform', k);
        continue;
      }
      let lastVal;
      let textureNumber = null;
      this.uniformSetters.push(() => {
        let val = this.uniforms[k];

        if (typeof val == 'function')
          val = val();
        return () => {
          if (val instanceof WebGLTexture) {
            if (textureNumber == null)
              textureNumber = nextTextureNumber++;
            gl.activeTexture(gl.TEXTURE0 + textureNumber);
            gl.bindTexture(gl.TEXTURE_2D, val);
            gl.uniform1i(loc, textureNumber);
            return;
          }
          if (val == lastVal)
            return;
          if (!Array.isArray(val))
            val = [val];
          lastVal = val;
          gl[`uniform${val.length}f`](loc, ...val);
        };
      });
    }
  }
  checkReady() {
    const { gl } = this;
    if (this.linking)
      return false;
    if (this.ready != null)
      return this.ready;
    // return this.gl.getProgramParameter(this.program, this.parallelExt.COMPLETION_STATUS_KHR);
    if (gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      const pLoc = gl.getUniformLocation(this.program, "p_in");
      gl.enableVertexAttribArray(pLoc);
      gl.vertexAttribPointer(pLoc, 3, gl.FLOAT, false, 0, 0);
      this.buildUniforms();
      return (this.ready = true);
    }

    if (!gl.getShaderParameter(this.vs.shader, gl.COMPILE_STATUS)) {
      this.error = new Error("Error in vertex shader");
      this.error.infoLog = gl.getShaderInfoLog(this.vs.shader);
      this.error.shaderSource = this.vs.text;
    } else if (!gl.getShaderParameter(this.fs.shader, gl.COMPILE_STATUS)) {
      this.error = new Error("Error in fragment shader");
      this.error.infoLog = gl.getShaderInfoLog(this.fs.shader);
      this.error.shaderSource = this.fs.text;
    } else {
      this.error = new Error("Error linking");
      this.error.infoLog = gl.getProgramInfoLog(this.program);
    }
    return (this.ready = false);
  }
  draw() {
    const { gl } = this;

    const doDraw = () => {
      gl.useProgram(this.program);
      for (const setter of this.uniformSetters.map(s => s()))
        setter();
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.mesh.length / 3);
    };

    if (this.fbs) {
      this.uniforms.u_fb = this.fbs[1].tex;
      this.fbs[0].drawInto(doDraw);

      if (this.copyProgram.checkReady()) {
        this.copyProgram.uniforms.buf = this.fbs[0].tex;
        this.copyProgram.draw();
      } else {
        if (this.copyProgram.error)
          console.log(this.copyProgram.error);
      }
      this.fbs.reverse();
    } else {
      doDraw();
    }
  }
}
