const express = require("express");
const { chromium } = require("playwright");
const { decode } = require("@msgpack/msgpack");

const PORT = Number(process.env.PORT || 3000);
const HEADLESS = String(process.env.HEADLESS || "true").toLowerCase() !== "false";
const DEBUG_RENDER = String(process.env.DEBUG_RENDER || "false").toLowerCase() === "true";
const BLOCK_HEAVY_RESOURCES = String(process.env.BLOCK_HEAVY_RESOURCES || "false").toLowerCase() === "true";
const COCOS_RUNTIME_TIMEOUT_MS = Number(process.env.COCOS_RUNTIME_TIMEOUT_MS || 180000);
const PAGE_LOAD_EXTRA_WAIT_MS = Number(process.env.PAGE_LOAD_EXTRA_WAIT_MS || 15000);

const START_URLS = String(
  process.env.START_URLS || "https://web.sunwin.med/?affId=Sunwin,https://sunwin.med/?affId=Sunwin"
)
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const SUNWIN_USERNAME = process.env.SUNWIN_USERNAME || "";
const SUNWIN_PASSWORD = process.env.SUNWIN_PASSWORD || "";

const RECONNECT_DELAY_MS = Number(process.env.RECONNECT_DELAY_MS || 10000);
const NO_RESULT_TIMEOUT_MS = Number(process.env.NO_RESULT_TIMEOUT_MS || 240000);

let latestResult = null;
let currentSessionId = null;
let lastPrintedKey = null;

let status = {
  startedAt: new Date().toISOString(),
  collectorState: "starting",
  currentUrl: null,
  lastError: null,
  lastSocketUrl: null,
  socketCount: 0,
  lastFrameAt: null,
  lastResultAt: null,
  loginAttemptAt: null,
  loginDoneAt: null,
  reconnectCount: 0
};

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeUrl(url) {
  if (!url) return null;
  return url.replace(/token=([^&]+)/gi, "token=***REDACTED***");
}

function normalizeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isDiceValue(value) {
  const n = normalizeNumber(value);
  return n !== null && n >= 1 && n <= 6;
}

function tinhKetQua(tong) {
  return tong >= 11 ? "Tài" : "Xỉu";
}

function decodeWsPayload(payloadData, opcode) {
  if (opcode === 2) {
    const buffer = Buffer.from(payloadData, "base64");
    return decode(buffer);
  }

  try {
    return JSON.parse(payloadData);
  } catch {
    return payloadData;
  }
}

function extractObjectFromDecoded(decoded) {
  if (Array.isArray(decoded)) {
    for (const item of decoded) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return item;
      }
    }
  }

  if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
    return decoded;
  }

  return null;
}

function isTaixiuPluginCall(decoded) {
  return (
    Array.isArray(decoded) &&
    decoded.length >= 4 &&
    decoded[1] === "MiniGame" &&
    decoded[2] === "taixiuPlugin"
  );
}

function handleDecodedFrame(decoded, meta) {
  status.lastFrameAt = nowIso();

  if (isTaixiuPluginCall(decoded)) {
    const obj = extractObjectFromDecoded(decoded);

    if (obj && obj.cmd === 1005) {
      console.log("[TX] Client gọi taixiuPlugin cmd 1005");
    }

    return;
  }

  const obj = extractObjectFromDecoded(decoded);
  if (!obj || typeof obj.cmd === "undefined") return;

  const cmd = Number(obj.cmd);

  if (cmd === 1002) {
    if (obj.sid !== undefined) {
      currentSessionId = obj.sid;
      console.log("[TX] Phiên mới:", currentSessionId);
    }
    return;
  }

  if (cmd === 1005) {
    if (obj.sid !== undefined) {
      currentSessionId = obj.sid;
    }

    console.log("[TX] Trạng thái ban đầu:", {
      sid: currentSessionId,
      rmT: obj.rmT
    });

    return;
  }

  if (cmd === 1003 || cmd === 1004) {
    const d1 = normalizeNumber(obj.d1);
    const d2 = normalizeNumber(obj.d2);
    const d3 = normalizeNumber(obj.d3);

    if (!isDiceValue(d1) || !isDiceValue(d2) || !isDiceValue(d3)) {
      return;
    }

    const tong = d1 + d2 + d3;
    const ketQua = tinhKetQua(tong);

    const phien =
      obj.sid ??
      obj.sessionId ??
      obj.phien ??
      currentSessionId ??
      null;

    const key = `${phien}:${d1}-${d2}-${d3}`;
    if (key === lastPrintedKey) return;
    lastPrintedKey = key;

    latestResult = {
      ket_qua: ketQua,
      phien,
      thoi_gian: nowIso(),
      tong,
      xuc_xac_1: d1,
      xuc_xac_2: d2,
      xuc_xac_3: d3
    };

    status.lastResultAt = latestResult.thoi_gian;

    console.log("");
    console.log("====================================");
    console.log("[KẾT QUẢ TÀI XỈU]");
    console.log("Phiên:", latestResult.phien);
    console.log("Xúc xắc:", `${d1} - ${d2} - ${d3}`);
    console.log("Tổng:", tong);
    console.log("Kết quả:", ketQua);
    console.log("CMD:", cmd);
    console.log("Thời gian:", latestResult.thoi_gian);
    console.log("====================================");
    console.log("");
  }
}

async function clickIfVisible(page, selectors, timeout = 1200) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: "visible", timeout });
      await locator.click({ timeout });
      return true;
    } catch {}
  }

  return false;
}

async function fillFirstVisible(page, selectors, value, timeout = 2000) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      await locator.waitFor({ state: "visible", timeout });
      await locator.fill(value, { timeout });
      return true;
    } catch {}
  }

  return false;
}

async function clickLoginEntryButton(page) {
  console.log("[LOGIN] Đợi giao diện chính load xong trước khi bấm Đăng nhập...");

  // Web này load canvas khá lâu, không nên bấm sớm.
  const waitMs = Number(process.env.LOGIN_SCREEN_WAIT_MS || 20000);
  await sleep(waitMs);

  // Chụp ảnh trước khi click để debug nếu cần.
  try {
    await page.screenshot({
      path: "logs/before-login-click.png",
      fullPage: false
    });
    console.log("[LOGIN] Đã chụp logs/before-login-click.png");
  } catch {}

  const viewport = page.viewportSize() || { width: 1280, height: 720 };

  // Theo giao diện bạn gửi, nút ĐĂNG NHẬP nằm gần phía trên, lệch phải.
  // Chỉ click 1 lần, không click nhiều tọa độ nữa.
  const x = Math.floor(viewport.width * 0.59);
  const y = Math.floor(viewport.height * 0.12);

  console.log(`[LOGIN] Click nút Đăng nhập tại tọa độ x=${x}, y=${y}`);
  await page.mouse.click(x, y);

  // Đợi form login hiện ra.
  await sleep(5000);

  try {
    await page.screenshot({
      path: "logs/after-login-click.png",
      fullPage: false
    });
    console.log("[LOGIN] Đã chụp logs/after-login-click.png");
  } catch {}

  const passwordInputCount = await page.locator('input[type="password"]').count().catch(() => 0);

  if (passwordInputCount > 0) {
    console.log("[LOGIN] Form đăng nhập đã xuất hiện.");
    return true;
  }

  console.log("[LOGIN] Chưa thấy form đăng nhập sau khi click.");
  return false;
}

async function autoLogin(page) {
  if (!SUNWIN_USERNAME || !SUNWIN_PASSWORD) {
    throw new Error("Thiếu SUNWIN_USERNAME hoặc SUNWIN_PASSWORD trong biến môi trường");
  }

  status.loginAttemptAt = nowIso();
  console.log("[LOGIN] Bắt đầu đăng nhập bằng Cocos method...");

  console.log("[LOGIN] Đợi thêm sau page.goto để asset Cocos tải...");
  await sleep(PAGE_LOAD_EXTRA_WAIT_MS);

  if (DEBUG_RENDER) {
    const pageInfo = await page.evaluate(() => {
      return {
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        hasCc: Boolean(window.cc),
        hasGameCanvas: Boolean(window.gameCanvas),
        hasCanvas: Boolean(document.querySelector("canvas")),
        scriptCount: document.scripts ? document.scripts.length : 0,
        bodyTextPreview: document.body ? document.body.innerText.slice(0, 300) : null,
        userAgent: navigator.userAgent,
        webdriver: navigator.webdriver
      };
    }).catch((err) => ({ error: err.message }));

    console.log("[DEBUG PAGE BEFORE COCOS]", pageInfo);
  }

  await page.waitForFunction(() => {
    return Boolean(
      window.cc &&
      cc.director &&
      typeof cc.director.getScene === "function" &&
      cc.director.getScene()
    );
  }, null, { timeout: COCOS_RUNTIME_TIMEOUT_MS });

  console.log("[LOGIN] Cocos runtime đã sẵn sàng.");

  await page.addInitScript(() => {});

  async function waitForCocosComponent(componentName, timeout = 120000) {
    await page.waitForFunction((componentName) => {
      function findComponentInScene(componentName) {
        const scene = cc.director.getScene();
        if (!scene) return null;

        const stack = [scene];

        while (stack.length > 0) {
          const node = stack.pop();

          const comps = node._components || [];
          for (const comp of comps) {
            const name =
              comp.__classname__ ||
              comp.name ||
              (comp.constructor && comp.constructor.name) ||
              "";

            if (name === componentName) {
              return comp;
            }
          }

          const children = node.children || node._children || [];
          for (const child of children) {
            stack.push(child);
          }
        }

        return null;
      }

      return Boolean(findComponentInScene(componentName));
    }, componentName, { timeout });
  }

  console.log("[LOGIN] Đang đợi LobbyViewController load xong...");
  await waitForCocosComponent("LobbyViewController", 120000);
  console.log("[LOGIN] LobbyViewController đã sẵn sàng.");

    const openResult = await page.evaluate(async () => {
    function sleepInPage(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function findComponentInScene(componentName) {
      const scene = cc.director.getScene();
      if (!scene) return null;

      const stack = [scene];

      while (stack.length > 0) {
        const node = stack.pop();

        const comps = node._components || [];
        for (const comp of comps) {
          const name =
            comp.__classname__ ||
            comp.name ||
            (comp.constructor && comp.constructor.name) ||
            "";

          if (name === componentName) {
            return comp;
          }
        }

        const children = node.children || node._children || [];
        for (const child of children) {
          stack.push(child);
        }
      }

      return null;
    }

    function findButtonComponent(node) {
      if (!node) return null;

      const targetNode = node.node ? node.node : node;
      const comps = targetNode._components || [];

      return comps.find((comp) => {
        const name =
          comp.__classname__ ||
          comp.name ||
          (comp.constructor && comp.constructor.name) ||
          "";

        return name === "cc.Button" || name === "Button";
      });
    }

    function makeFakeTouchEvent(node) {
      const p = cc.v2 ? cc.v2(0, 0) : { x: 0, y: 0 };

      return {
        type: "touch-end",
        target: node,
        currentTarget: node,
        eventPhase: 2,
        propagationStopped: false,
        propagationImmediateStopped: false,
        preventSwallow: false,
        touch: {
          getLocation() {
            return p;
          },
          getUILocation() {
            return p;
          },
          getPreviousLocation() {
            return p;
          },
          getDelta() {
            return p;
          }
        },
        getLocation() {
          return p;
        },
        getUILocation() {
          return p;
        },
        getPreviousLocation() {
          return p;
        },
        getDelta() {
          return p;
        },
        stopPropagation() {
          this.propagationStopped = true;
        },
        stopPropagationImmediate() {
          this.propagationImmediateStopped = true;
        }
      };
    }

    function triggerCocosButton(node) {
      if (!node) {
        return {
          ok: false,
          error: "Không có node button"
        };
      }

      const targetNode = node.node ? node.node : node;
      const button = findButtonComponent(targetNode);
      const event = makeFakeTouchEvent(targetNode);
      const tried = [];

      if (button) {
        try {
          if (typeof button._onTouchBegan === "function") {
            button._onTouchBegan(event);
            tried.push("button._onTouchBegan");
          }
        } catch (err) {
          tried.push("button._onTouchBegan error: " + err.message);
        }

        try {
          if (typeof button._onTouchEnded === "function") {
            button._onTouchEnded(event);
            tried.push("button._onTouchEnded");
          }
        } catch (err) {
          tried.push("button._onTouchEnded error: " + err.message);
        }

        try {
          if (
            cc.Component &&
            cc.Component.EventHandler &&
            typeof cc.Component.EventHandler.emitEvents === "function" &&
            Array.isArray(button.clickEvents)
          ) {
            cc.Component.EventHandler.emitEvents(button.clickEvents, event);
            tried.push("EventHandler.emitEvents(clickEvents)");
          }
        } catch (err) {
          tried.push("emitEvents error: " + err.message);
        }
      }

      try {
        if (cc.Node && cc.Node.EventType) {
          targetNode.emit(cc.Node.EventType.TOUCH_START, event);
          targetNode.emit(cc.Node.EventType.TOUCH_END, event);
          tried.push("node.emit TOUCH_START/TOUCH_END");
        }
      } catch (err) {
        tried.push("node.emit error: " + err.message);
      }

      return {
        ok: true,
        tried
      };
    }

    const lobby = findComponentInScene("LobbyViewController");

    if (!lobby) {
      return {
        ok: false,
        error: "Không tìm thấy LobbyViewController"
      };
    }

    if (typeof lobby.isLoggedIn === "function" && lobby.isLoggedIn()) {
      return {
        ok: true,
        alreadyLoggedIn: true
      };
    }

    const attempts = [];

    // Cách 1: gọi method nếu có.
    try {
      if (typeof lobby.showLoginPopup === "function") {
        lobby.showLoginPopup();
        attempts.push("lobby.showLoginPopup()");
        await sleepInPage(3000);

        if (findComponentInScene("LoginPopup")) {
          return {
            ok: true,
            openedLoginPopup: true,
            method: "showLoginPopup",
            attempts
          };
        }
      }
    } catch (err) {
      attempts.push("showLoginPopup error: " + err.message);
    }

    // Cách 2: kích hoạt chính node btn_login của Cocos.
    try {
      const triggerResult = triggerCocosButton(lobby.btn_login);
      attempts.push({
        method: "trigger lobby.btn_login",
        triggerResult
      });

      await sleepInPage(5000);

      if (findComponentInScene("LoginPopup")) {
        return {
          ok: true,
          openedLoginPopup: true,
          method: "trigger lobby.btn_login",
          attempts
        };
      }
    } catch (err) {
      attempts.push("trigger btn_login error: " + err.message);
    }

    return {
      ok: false,
      error: "Đã thử showLoginPopup và trigger btn_login nhưng LoginPopup vẫn chưa xuất hiện",
      attempts
    };
  });

  if (!openResult.ok) {
    throw new Error(openResult.error || "Không mở được login popup bằng Cocos");
  }

  console.log("[LOGIN] Kết quả mở LoginPopup:", openResult);

  if (openResult.alreadyLoggedIn) {
    status.loginDoneAt = nowIso();
    console.log("[LOGIN] Tài khoản đã đăng nhập sẵn.");
    return;
  }

  console.log("[LOGIN] Đang đợi LoginPopup xuất hiện...");
  await waitForCocosComponent("LoginPopup", 120000);
  console.log("[LOGIN] LoginPopup đã sẵn sàng.");

  await sleep(1000);

  const loginResult = await page.evaluate(({ username, password }) => {
    function findComponentInScene(componentName) {
      const scene = cc.director.getScene();
      if (!scene) return null;

      const stack = [scene];

      while (stack.length > 0) {
        const node = stack.pop();

        const comps = node._components || [];
        for (const comp of comps) {
          const name =
            comp.__classname__ ||
            comp.name ||
            (comp.constructor && comp.constructor.name) ||
            "";

          if (name === componentName) {
            return comp;
          }
        }

        const children = node.children || node._children || [];
        for (const child of children) {
          stack.push(child);
        }
      }

      return null;
    }

    function findEditBox(node) {
      if (!node) return null;

      const targetNode = node.node ? node.node : node;
      const comps = targetNode._components || [];

      return comps.find((comp) => {
        const name =
          comp.__classname__ ||
          comp.name ||
          (comp.constructor && comp.constructor.name) ||
          "";

        return name === "cc.EditBox" || name === "EditBox";
      });
    }

    function setEditBoxValue(editBoxNodeOrComp, value) {
      if (!editBoxNodeOrComp) return false;

      const editBox = findEditBox(editBoxNodeOrComp);

      if (!editBox) return false;

      try {
        editBox.string = value;
      } catch {}

      try {
        editBox._string = value;
      } catch {}

      try {
        if (typeof editBox._updateString === "function") {
          editBox._updateString();
        }
      } catch {}

      try {
        if (typeof editBox._updateTextLabel === "function") {
          editBox._updateTextLabel();
        }
      } catch {}

      try {
        if (
          cc.Component &&
          cc.Component.EventHandler &&
          typeof cc.Component.EventHandler.emitEvents === "function" &&
          Array.isArray(editBox.textChanged)
        ) {
          cc.Component.EventHandler.emitEvents(editBox.textChanged, value, editBox);
        }
      } catch {}

      try {
        if (
          cc.Component &&
          cc.Component.EventHandler &&
          typeof cc.Component.EventHandler.emitEvents === "function" &&
          Array.isArray(editBox.editingDidEnded)
        ) {
          cc.Component.EventHandler.emitEvents(editBox.editingDidEnded, editBox);
        }
      } catch {}

      return true;
    }

    const loginPopup = findComponentInScene("LoginPopup");

    if (!loginPopup) {
      return {
        ok: false,
        error: "Không tìm thấy LoginPopup"
      };
    }

    loginPopup.currentUsername = username;
    loginPopup.currentPassword = password;

    const setUsername = setEditBoxValue(loginPopup.edtBox_username, username);
    const setPassword = setEditBoxValue(loginPopup.edtBox_password, password);

    if (typeof loginPopup.loginAcc !== "function") {
      return {
        ok: false,
        error: "LoginPopup không có method loginAcc",
        setUsername,
        setPassword,
        currentUsername: loginPopup.currentUsername,
        currentPasswordLength: loginPopup.currentPassword ? loginPopup.currentPassword.length : 0
      };
    }

    loginPopup.loginAcc();

    return {
      ok: true,
      called: "loginAcc",
      setUsername,
      setPassword,
      currentUsername: loginPopup.currentUsername,
      currentPasswordLength: loginPopup.currentPassword ? loginPopup.currentPassword.length : 0,
      isLogging: loginPopup.is_logging ?? null,
      hasCaptchaNode: Boolean(loginPopup.capcha_node)
    };
  }, {
    username: SUNWIN_USERNAME,
    password: SUNWIN_PASSWORD
  });

  if (!loginResult.ok) {
    throw new Error(loginResult.error || "Không gọi được LoginPopup.loginAcc");
  }

  console.log("[LOGIN] Đã gọi LoginPopup.loginAcc:", {
    ok: loginResult.ok,
    called: loginResult.called,
    setUsername: loginResult.setUsername,
    setPassword: loginResult.setPassword,
    currentPasswordLength: loginResult.currentPasswordLength,
    isLogging: loginResult.isLogging,
    hasCaptchaNode: loginResult.hasCaptchaNode
  });

  await sleep(12000);

  const checkLogin = await page.evaluate(() => {
    function findComponentInScene(componentName) {
      const scene = cc.director.getScene();
      if (!scene) return null;

      const stack = [scene];

      while (stack.length > 0) {
        const node = stack.pop();

        const comps = node._components || [];
        for (const comp of comps) {
          const name =
            comp.__classname__ ||
            comp.name ||
            (comp.constructor && comp.constructor.name) ||
            "";

          if (name === componentName) {
            return comp;
          }
        }

        const children = node.children || node._children || [];
        for (const child of children) {
          stack.push(child);
        }
      }

      return null;
    }

    const lobby = findComponentInScene("LobbyViewController");

    if (!lobby) {
      return {
        foundLobby: false,
        loggedIn: false
      };
    }

    let loggedIn = false;

    try {
      if (typeof lobby.isLoggedIn === "function") {
        loggedIn = Boolean(lobby.isLoggedIn());
      }
    } catch {}

    return {
      foundLobby: true,
      loggedIn,
      loginError: lobby.login_error ?? null,
      hasLoginData: Boolean(lobby.loginData),
      name: lobby.lb_name && lobby.lb_name.string ? lobby.lb_name.string : null,
      money: lobby.lb_tien && lobby.lb_tien.string ? lobby.lb_tien.string : null
    };
  });

  console.log("[LOGIN] Kiểm tra trạng thái:", checkLogin);

  status.loginDoneAt = nowIso();

  if (checkLogin.loggedIn) {
    console.log("[LOGIN] Đăng nhập thành công.");
  } else {
    console.log("[LOGIN] Chưa xác nhận được isLoggedIn=true, nhưng vẫn tiếp tục chờ WebSocket.");
  }
}

async function tryGotoOneUrl(page) {
  let lastError = null;

  for (const url of START_URLS) {
    try {
      status.currentUrl = url;
      console.log("[PAGE] Đang mở:", url);

      await page.goto(url, { waitUntil: "load", timeout: 180000 });
      await sleep(5000);

      return url;
    } catch (err) {
      lastError = err;
      console.log("[PAGE] Lỗi URL:", url, err.message);
    }
  }

  throw lastError || new Error("Không mở được URL nào trong START_URLS");
}

async function runCollectorOnce() {
  status.collectorState = "launching-browser";

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",

      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",

      "--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-first-run",

      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1280,720"
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  });

  const page = await context.newPage();
  page.on("console", (msg) => {
    if (!DEBUG_RENDER) return;
    const type = msg.type();
    const text = msg.text();
    if (["error", "warning"].includes(type)) {
      console.log(`[BROWSER ${type.toUpperCase()}]`, text.slice(0, 500));
    }
  });

  page.on("pageerror", (err) => {
    console.log("[BROWSER PAGE ERROR]", err.message);
  });

  page.on("requestfailed", (request) => {
    if (!DEBUG_RENDER) return;
    const url = request.url();
    const failure = request.failure();
    if (
      url.includes("sunwin") ||
      url.includes("azhkthg") ||
      url.includes("bundle") ||
      url.includes("import-map") ||
      url.includes("assets")
    ) {
      console.log("[REQ FAILED]", request.resourceType(), url.slice(0, 300), failure?.errorText);
    }
  });

  if (BLOCK_HEAVY_RESOURCES) {
    await page.route("**/*", async (route) => {
      const request = route.request();
      const type = request.resourceType();
      const url = request.url();

      // Không chặn script/xhr/websocket/document vì Cocos cần.
      if (["image", "media", "font"].includes(type)) {
        return route.abort().catch(() => {});
      }

      // Chặn một số thứ phụ không cần cho đọc WebSocket.
      if (
        url.includes("google-analytics") ||
        url.includes("googletagmanager") ||
        url.includes("facebook") ||
        url.includes("doubleclick")
      ) {
        return route.abort().catch(() => {});
      }

      return route.continue().catch(() => {});
    });
  }

  const client = await context.newCDPSession(page);
  await client.send("Network.enable");

  const socketMap = new Map();

  client.on("Network.webSocketCreated", (event) => {
    socketMap.set(event.requestId, {
      requestId: event.requestId,
      url: event.url
    });

    status.socketCount += 1;
    status.lastSocketUrl = safeUrl(event.url);

    console.log("[WS CREATED]", event.requestId, safeUrl(event.url));
  });

  client.on("Network.webSocketClosed", (event) => {
    const socket = socketMap.get(event.requestId);
    console.log("[WS CLOSED]", event.requestId, safeUrl(socket?.url));
  });

  function handleFrame(event, direction) {
    try {
      const socket = socketMap.get(event.requestId);
      const payloadData = event.response.payloadData || "";
      const opcode = event.response.opcode;

      const decoded = decodeWsPayload(payloadData, opcode);

      handleDecodedFrame(decoded, {
        direction,
        opcode,
        url: socket ? socket.url : null
      });
    } catch (err) {
      // Bỏ qua frame không decode được vì socket có rất nhiều dữ liệu phụ.
    }
  }

  client.on("Network.webSocketFrameReceived", (event) => {
    handleFrame(event, "received");
  });

  client.on("Network.webSocketFrameSent", (event) => {
    handleFrame(event, "sent");
  });

  try {
    status.collectorState = "opening-page";
    await tryGotoOneUrl(page);

    status.collectorState = "login";
    await autoLogin(page);

    status.collectorState = "running";

    while (true) {
      await sleep(15000);

      if (status.lastResultAt) {
        const age = Date.now() - new Date(status.lastResultAt).getTime();

        if (age > NO_RESULT_TIMEOUT_MS) {
          throw new Error(`Quá lâu chưa có kết quả mới: ${age}ms`);
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function collectorLoop() {
  while (true) {
    try {
      status.collectorState = "starting";
      status.lastError = null;

      await runCollectorOnce();
    } catch (err) {
      status.collectorState = "error";
      status.lastError = {
        time: nowIso(),
        message: err.message
      };

      status.reconnectCount += 1;

      console.log("[COLLECTOR ERROR]", err.message);
      console.log(`[COLLECTOR] Reconnect sau ${RECONNECT_DELAY_MS}ms...`);

      await sleep(RECONNECT_DELAY_MS);
    }
  }
}

const app = express();

app.get("/", (req, res) => {
  res.json({
    status: "running",
    api: "/api/tx",
    health: "/health",
    debug: "/debug"
  });
});

app.get("/api/tx", (req, res) => {
  if (!latestResult) {
    return res.json({
      status: "waiting",
      message: "Chưa có dữ liệu Tài Xỉu",
      collector: status.collectorState,
      lastError: status.lastError
    });
  }

  return res.json({
    status: "ok",
    data: latestResult
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    collector: status.collectorState,
    hasResult: Boolean(latestResult),
    latestPhien: latestResult?.phien ?? null,
    lastResultAt: status.lastResultAt,
    lastError: status.lastError
  });
});

app.get("/debug", (req, res) => {
  res.json({
    status,
    latestResult
  });
});

app.listen(PORT, () => {
  console.log(`[API] Server đang chạy ở http://localhost:${PORT}`);
  console.log("[API] /api/tx");
  console.log("[API] /health");
  console.log("[API] /debug");
  console.log("[CONFIG] HEADLESS =", HEADLESS);
  console.log("[CONFIG] START_URLS =", START_URLS);
  console.log("");

  collectorLoop();
});