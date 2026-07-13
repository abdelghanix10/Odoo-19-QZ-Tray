/** @odoo-module **/

import { registry } from "@web/core/registry";

const CONNECT_TIMEOUT_MS = 5000;
const PRINT_TIMEOUT_MS = 10000;
const PRINTER_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 60000;
const LOG_PREFIX = "[QZ]";

function ts() {
  return new Date().toISOString().substring(11, 23);
}

function log(...args) {
  console.log(LOG_PREFIX, `[${ts()}]`, ...args);
}

function warn(...args) {
  console.warn(LOG_PREFIX, `[${ts()}]`, ...args);
}

function error(...args) {
  console.error(LOG_PREFIX, `[${ts()}]`, ...args);
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export const qzTrayService = {
  async start(env) {
    // --- State ---
    let securityConfigured = false;
    let cachedCert = null;
    let cachedPrivateKey = null;
    let importedKey = null;
    let cachedPrinterName = null;
    let reconnectPromise = null; // coalesce concurrent reconnects
    let heartbeatTimer = null;
    let printingInProgress = false; // guard heartbeat during print
    let destroyed = false;

    // --- Security cache initialization ---

    const initSecurityCache = async () => {
      try {
        const certRes = await fetch("/qz/certificate");
        if (certRes.ok) {
          cachedCert = await certRes.text();
        }
      } catch (e) {
        warn("Failed to pre-cache QZ certificate:", e);
      }

      try {
        const keyRes = await fetch("/qz/private_key");
        if (keyRes.ok) {
          cachedPrivateKey = await keyRes.text();
        }
      } catch (e) {
        warn("Failed to pre-cache QZ private key:", e);
      }
    };

    initSecurityCache();

    // --- Crypto helpers ---

    const getImportedKey = async () => {
      if (importedKey) {
        return importedKey;
      }
      if (!cachedPrivateKey) {
        return null;
      }

      try {
        const pemHeader = "-----BEGIN PRIVATE KEY-----";
        const pemFooter = "-----END PRIVATE KEY-----";
        const startIdx = cachedPrivateKey.indexOf(pemHeader);
        const endIdx = cachedPrivateKey.indexOf(pemFooter);
        if (startIdx === -1 || endIdx === -1) {
          throw new Error("Invalid PEM format for private key");
        }
        const pemContents = cachedPrivateKey.substring(
          startIdx + pemHeader.length,
          endIdx
        );
        const base64 = pemContents.replace(/\s+/g, "");
        const binaryDerString = window.atob(base64);
        const len = binaryDerString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryDerString.charCodeAt(i);
        }

        importedKey = await window.crypto.subtle.importKey(
          "pkcs8",
          bytes.buffer,
          {
            name: "RSASSA-PKCS1-v1_5",
            hash: { name: "SHA-1" },
          },
          false,
          ["sign"]
        );
        return importedKey;
      } catch (e) {
        error("Error importing private key for client-side signing:", e);
        return null;
      }
    };

    const signMessageLocally = async (toSign) => {
      const key = await getImportedKey();
      if (!key) {
        throw new Error("Private key not available for client-side signing");
      }

      const encoder = new TextEncoder();
      const data = encoder.encode(toSign);
      const signatureBuffer = await window.crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        data
      );

      const signatureArray = new Uint8Array(signatureBuffer);
      let binary = "";
      for (let i = 0; i < signatureArray.byteLength; i++) {
        binary += String.fromCharCode(signatureArray[i]);
      }
      return window.btoa(binary);
    };

    // --- QZ accessors ---

    const getQZ = () => {
      if (typeof window !== "undefined" && window.qz) {
        return window.qz;
      }
      return null;
    };

    const waitForQZ = async (timeout = 5000) => {
      const startTime = Date.now();
      while (!getQZ() && Date.now() - startTime < timeout) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return getQZ();
    };

    // --- Security configuration ---

    const configureSecurity = (qz) => {
      if (securityConfigured) {
        return;
      }

      qz.security.setCertificatePromise(function (resolve, reject) {
        if (cachedCert) {
          resolve(cachedCert);
        } else {
          fetch("/qz/certificate")
            .then((response) => {
              if (!response.ok) {
                throw new Error(`Certificate fetch failed: ${response.status}`);
              }
              return response.text();
            })
            .then(resolve)
            .catch(reject);
        }
      });

      qz.security.setSignaturePromise(function (toSign) {
        return function (resolve, reject) {
          signMessageLocally(toSign)
            .then(resolve)
            .catch((localSignError) => {
              warn(
                "Client-side signing failed, falling back to server:",
                localSignError
              );
              fetch("/qz/sign", {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: toSign,
              })
                .then((response) => {
                  if (!response.ok) {
                    throw new Error(`Signing failed: ${response.status}`);
                  }
                  return response.text();
                })
                .then(resolve)
                .catch(reject);
            });
        };
      });

      securityConfigured = true;
    };

    // --- Connection management ---

    const safeDisconnect = async (reason = "unspecified") => {
      const qz = getQZ();
      if (!qz) return;

      try {
        await qz.websocket.disconnect();
      } catch (e) {
        warn("Disconnect error (ignored) — reason:", reason, "—", e.message || e);
      }
    };

    const connect = async () => {
      const qz = await waitForQZ();
      if (!qz) {
        throw new Error(
          "QZ Tray library not loaded. Make sure qz-tray.js is included in assets."
        );
      }

      configureSecurity(qz);

      const t0 = Date.now();
      try {
        await withTimeout(
          qz.websocket.connect({
            host: "localhost",
            port: {
              secure: [8181],
              insecure: [],
            },
            usingSecure: true,
            keepAlive: 60,
          }),
          CONNECT_TIMEOUT_MS,
          "QZ websocket connect"
        );
      } catch (e) {
        const msg = (e.message || String(e)).toLowerCase();
        // "Already connected" / "already exists" are not errors — treat as success
        if (msg.includes("already connected") || msg.includes("already exists")) {
          return;
        }
        // Connect failed — ensure no half-open socket
        warn("Connect failed, cleaning up —", e.message);
        await safeDisconnect("connect failure cleanup");
        throw e;
      }

    };

    /**
     * Coalesced reconnect — only one reconnect runs at a time.
     * Concurrent callers await the same promise.
     */
    const reconnect = async (reason = "unspecified") => {
      if (reconnectPromise) {
        return reconnectPromise;
      }

      reconnectPromise = (async () => {
        const t0 = Date.now();

        try {
          await safeDisconnect("reconnect: " + reason);
          await connect();

          if (!getQZ()?.websocket.isActive()) {
            throw new Error("Websocket still inactive after reconnect");
          }

          // Invalidate cached printer after reconnect — it may reference stale state
          cachedPrinterName = null;
        } catch (e) {
          error("Reconnect failed — took", Date.now() - t0, "ms —", e.message);
          throw e;
        } finally {
          reconnectPromise = null;
        }
      })();

      return reconnectPromise;
    };

    /**
     * Single source of truth for connection state.
     */
    const ensureConnected = async (reason = "unspecified") => {
      const qz = getQZ();
      if (!qz) {
        throw new Error("QZ Tray library not loaded.");
      }

      if (qz.websocket.isActive()) {
        return;
      }

      await reconnect(reason);
    };

    // --- Error classification ---

    const isConnectionError = (err) => {
      const msg = (err && err.message || String(err)).toLowerCase();
      return (
        msg.includes("websocket closed") ||
        msg.includes("connection lost") ||
        msg.includes("already connected") ||
        msg.includes("already exists") ||
        msg.includes("connection refused") ||
        msg.includes("not connected") ||
        msg.includes("connection timed out") ||
        msg.includes("failed to connect") ||
        msg.includes("broken pipe") ||
        msg.includes("networkerror") ||
        msg.includes("aborterror")
      );
    };

    // --- Printer management ---

    const getDefaultPrinter = async () => {
      if (cachedPrinterName) {
        return cachedPrinterName;
      }

      const fetchPrinter = async () => {
        const qz = getQZ();
        return await withTimeout(
          qz.printers.getDefault(),
          PRINTER_TIMEOUT_MS,
          "getDefaultPrinter"
        );
      };

      try {
        await ensureConnected("getDefaultPrinter");
        cachedPrinterName = await fetchPrinter();
        return cachedPrinterName;
      } catch (e) {
        // If printer fetch failed, reconnect and retry once
        warn("getDefaultPrinter failed, reconnecting and retrying —", e.message);
        cachedPrinterName = null;
        await reconnect("getDefaultPrinter failure");
        cachedPrinterName = await fetchPrinter();
        return cachedPrinterName;
      }
    };

    // --- Print with retry ---

    const executePrint = async (printerName, data, type, options) => {
      const qz = getQZ();
      const config = qz.configs.create(printerName, {
        scaleContent: false,
        ...options,
      });

      const printData = [
        {
          type: type,
          format: type === "pixel" ? "html" : "command",
          flavor: type === "pixel" ? "plain" : "plain",
          data: data,
        },
      ];

      await withTimeout(
        qz.print(config, printData),
        PRINT_TIMEOUT_MS,
        "QZ print"
      );
    };

    const print = async (printerName, data, type = "pixel", options = {}) => {
      const qz = getQZ();
      if (!qz) {
        throw new Error("QZ Tray library not loaded.");
      }

      const t0 = Date.now();
      printingInProgress = true;

      try {
        // Attempt 1
        try {
          await ensureConnected("print:attempt1");
          await executePrint(printerName, data, type, options);
          return;
        } catch (firstErr) {
          warn("Print attempt 1 failed —", firstErr.message || firstErr);

          if (!isConnectionError(firstErr)) {
            error("Print failed (non-connection error):", firstErr);
            throw firstErr;
          }
        }

        // Connection error — force reconnect and retry once
        warn("Print attempt 1 connection error — reconnecting for retry");

        try {
          await reconnect("print:retry");
          await executePrint(printerName, data, type, options);
        } catch (retryErr) {
          error(
            "Print retry failed — gave up after",
            Date.now() - t0,
            "ms —",
            retryErr
          );
          throw retryErr;
        }
      } finally {
        printingInProgress = false;
      }
    };

    // --- Heartbeat ---

    const startHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }

      heartbeatTimer = setInterval(async () => {
        if (destroyed || printingInProgress) {
          return; // skip during active print or after destroy
        }

        const qz = getQZ();
        if (!qz) {
          return;
        }

        if (!qz.websocket.isActive()) {
          warn("Heartbeat: websocket inactive — triggering reconnect");
          try {
            await reconnect("heartbeat:inactive");
          } catch (e) {
            error("Heartbeat reconnect failed:", e.message);
          }
          return;
        }

        // Active probe — try a lightweight call
        try {
          await withTimeout(
            qz.printers.getDefault(),
            PRINTER_TIMEOUT_MS,
            "Heartbeat probe"
          );
          // Success — connection is alive, invalidate cached printer in case it changed
        } catch (e) {
          warn(
            "Heartbeat probe failed — websocket claims active but probe failed:",
            e.message
          );
          try {
            await reconnect("heartbeat:probe-failed");
          } catch (reconnErr) {
            error("Heartbeat reconnect failed:", reconnErr.message);
          }
        }
      }, HEARTBEAT_INTERVAL_MS);

    };

    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    // --- WebSocket close callback ---

    const registerCloseCallback = () => {
      const qz = getQZ();
      if (!qz?.websocket?.setClosedCallbacks) {
        return;
      }

      qz.websocket.setClosedCallbacks(function (data) {
        warn("WebSocket closed callback fired:", data);
        cachedPrinterName = null;
        // Don't reconnect here — let the next print or heartbeat trigger it.
        // Reconnecting inside a callback can race with QZ internal state.
      });

    };

    // --- Browser lifecycle recovery ---

    const registerBrowserLifecycle = () => {
      const recover = async (event) => {
        if (destroyed) return;

        const qz = getQZ();
        if (!qz) return;

        if (qz.websocket.isActive()) {
          return; // nothing to do
        }

        try {
          await reconnect("lifecycle:" + event);
        } catch (e) {
          error("Lifecycle reconnect failed:", e.message);
        }
      };

      window.addEventListener("focus", () => recover("focus"));
      window.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          recover("visibilitychange");
        }
      });
      window.addEventListener("online", () => recover("online"));

    };

    // --- Startup ---

    const qz = await waitForQZ();
    if (qz) {
      registerCloseCallback();
    }
    registerBrowserLifecycle();
    startHeartbeat();

    // --- Public API ---

    return {
      connect,
      print,
      getDefaultPrinter,
      getQZ,
    };
  },
};

registry.category("services").add("qz_tray", qzTrayService);
