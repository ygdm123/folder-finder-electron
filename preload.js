const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  chooseDir: () => ipcRenderer.invoke("choose-dir"),
  list: (dir, keyword) => ipcRenderer.invoke("list", dir, keyword),
  open: (p) => ipcRenderer.invoke("open", p),
  reveal: (p) => ipcRenderer.invoke("reveal", p),
  /* 拖拽移动：把外部文件移入某个子文件夹 */
  moveFiles: (srcs, destDir) => ipcRenderer.invoke("move-files", srcs, destDir),
  /* 拖入的 File 对象 → 磁盘真实路径（Electron ≥32 必须用 webUtils） */
  pathForFile: (file) => webUtils.getPathForFile(file),
  onInit: (cb) => ipcRenderer.on("init", (_e, dir) => cb(dir)),
});
