const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { pinyin } = require("pinyin-pro");

let win = null;
let currentDir = "";

const configPath = () => path.join(app.getPath("userData"), "config.json");

// 汉字转无声调全拼小写，作为排序键、搜索键与首字母分组依据
function pinyinKey(name) {
  try {
    return pinyin(name, { toneType: "none", type: "array" }).join("").toLowerCase();
  } catch {
    return name.toLowerCase();
  }
}

function listSubfolders(dir, keyword) {
  const kw = (keyword || "").trim().toLowerCase();
  try {
    const items = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => {
        const py = pinyinKey(d.name);
        const group = /^[a-z]/.test(py) ? py[0].toUpperCase() : "#";
        return { name: d.name, path: path.join(dir, d.name), py, group };
      })
      .filter((d) => !kw || d.name.toLowerCase().includes(kw) || d.py.includes(kw))
      .sort((a, b) => a.py.localeCompare(b.py) || a.name.localeCompare(b.name, "zh-Hans-CN"));
    return { ok: true, items, dir };
  } catch (e) {
    return { ok: false, error: e.message, items: [], dir };
  }
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) || {};
  } catch {
    return {};
  }
}

function saveConfig(extra) {
  try {
    fs.writeFileSync(configPath(), JSON.stringify({ ...loadConfig(), dir: currentDir, ...extra }));
  } catch {}
}

/* ---------- 拖拽移动 ---------- */

// 目标同名时自动起不冲突的名字「name 2.ext」
function uniqueDest(destDir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let i = 2;
  let dest = path.join(destDir, `${base} ${i}${ext}`);
  while (fs.existsSync(dest)) {
    i++;
    dest = path.join(destDir, `${base} ${i}${ext}`);
  }
  return dest;
}

// 单个移动：冲突时逐个弹窗（替换 / 保留两者 / 跳过）
async function moveOne(src, destDir) {
  const dest = path.join(destDir, path.basename(src));
  if (dest === src) return { ok: false, skipped: true };

  let finalDest = dest;
  let keptBoth = false;
  if (fs.existsSync(dest)) {
    const r = await dialog.showMessageBox(win, {
      type: "warning",
      message: `「${path.basename(src)}」已存在于目标文件夹`,
      detail: `目标：${destDir}`,
      buttons: ["替换", "保留两者", "跳过"],
      defaultId: 2,
      cancelId: 2,
    });
    if (r.response === 2) return { ok: false, skipped: true };
    if (r.response === 1) {
      finalDest = uniqueDest(destDir, path.basename(src));
      keptBoth = true;
    } else {
      // 替换：先删除目标（文件夹同名也一样），再移入
      try {
        await fs.promises.rm(dest, { recursive: true, force: true });
      } catch {
        return { ok: false, failed: true };
      }
    }
  }

  try {
    await fs.promises.rename(src, finalDest);
    return { ok: true, replaced: !keptBoth && finalDest !== dest, keptBoth };
  } catch (e) {
    if (e.code === "EXDEV") {
      // 跨磁盘卷 rename 失败，退化为复制后删除
      try {
        await fs.promises.cp(src, finalDest, { recursive: true });
        await fs.promises.rm(src, { recursive: true, force: true });
        return { ok: true, replaced: !keptBoth && finalDest !== dest, keptBoth };
      } catch {
        return { ok: false, failed: true };
      }
    }
    return { ok: false, failed: true };
  }
}

ipcMain.handle("move-files", async (_e, srcs, destDir) => {
  const r = { moved: 0, replaced: 0, keptBoth: 0, skipped: 0, failed: [] };
  for (const src of srcs || []) {
    const res = await moveOne(src, destDir);
    if (res.ok) {
      if (res.replaced) r.replaced++;
      else if (res.keptBoth) r.keptBoth++;
      else r.moved++;
    } else if (res.skipped) r.skipped++;
    else r.failed.push(path.basename(src));
  }
  return r;
});

ipcMain.handle("list", (_e, dir, keyword) => listSubfolders(dir, keyword));
ipcMain.handle("open", (_e, p) => shell.openPath(p));            // 在访达中打开
ipcMain.handle("reveal", (_e, p) => { shell.showItemInFolder(p); return true; }); // 在访达中定位

ipcMain.handle("choose-dir", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "选择母文件夹",
    defaultPath: currentDir || app.getPath("home"),
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  currentDir = r.filePaths[0];
  saveConfig();
  return currentDir;
});

/* ---------- 窗口：长条面板，记忆大小与位置 ---------- */

function createWindow() {
  const cfg = loadConfig();
  const b = cfg.bounds || {};
  win = new BrowserWindow({
    width: b.width || 360,
    height: b.height || 640,
    x: b.x,
    y: b.y,
    minWidth: 280,
    minHeight: 380,
    title: "快速找文件夹",
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.loadFile("index.html");

  // 拖动/缩放结束后记住边界，下次原位打开
  let boundsTimer = null;
  const rememberBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (win && !win.isDestroyed() && !win.isMinimized() && !win.isFullScreen()) {
        saveConfig({ bounds: win.getBounds() });
      }
    }, 400);
  };
  win.on("resize", rememberBounds);
  win.on("move", rememberBounds);
}

app.whenReady().then(() => {
  loadConfig();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
