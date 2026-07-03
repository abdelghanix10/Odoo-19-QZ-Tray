/** @odoo-module **/

import { registry } from "@web/core/registry";

export const qzTrayService = {
  async start(env) {
    let isConnected = false;
    let securityConfigured = false;
    let cachedCert = null;
    let cachedPrivateKey = null;
    let importedKey = null;

    // Fetch certificate and private key during startup
    const initSecurityCache = async () => {
      try {
        const certRes = await fetch("/qz/certificate");
        if (certRes.ok) {
          cachedCert = await certRes.text();
          console.log("QZ Certificate cached client-side");
        }
      } catch (e) {
        console.warn("Failed to pre-cache QZ certificate:", e);
      }

      try {
        const keyRes = await fetch("/qz/private_key");
        if (keyRes.ok) {
          cachedPrivateKey = await keyRes.text();
          console.log("QZ Private Key cached client-side");
        }
      } catch (e) {
        console.warn("Failed to pre-cache QZ private key:", e);
      }
    };

    // Trigger initialization immediately
    initSecurityCache();

    // Helper to get Web Crypto key from cached PKCS#8 private key
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
        console.error("Error importing private key for client-side signing:", e);
        return null;
      }
    };

    // Helper to sign message using Web Crypto API
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

      // Convert ArrayBuffer to Base64
      const signatureArray = new Uint8Array(signatureBuffer);
      let binary = "";
      for (let i = 0; i < signatureArray.byteLength; i++) {
        binary += String.fromCharCode(signatureArray[i]);
      }
      return window.btoa(binary);
    };

    // Get QZ from window - it should be loaded by qz-tray.js before this module
    const getQZ = () => {
      if (typeof window !== "undefined" && window.qz) {
        return window.qz;
      }
      return null;
    };

    // Wait for QZ to be available (in case of async loading)
    const waitForQZ = async (timeout = 5000) => {
      const startTime = Date.now();
      while (!getQZ() && Date.now() - startTime < timeout) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return getQZ();
    };

    // Configure QZ Tray security (certificate and signing)
    const configureSecurity = (qz) => {
      if (securityConfigured) {
        return;
      }

      // Note: QZ Tray 2.2.x defaults to SHA1 for signing
      // Our server-side uses SHA1 as well, so no need to change algorithm

      // Set certificate promise - fetches the public certificate from Odoo
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

      // Set signature promise - signs authentication requests via Odoo
      qz.security.setSignaturePromise(function (toSign) {
        return function (resolve, reject) {
          signMessageLocally(toSign)
            .then(resolve)
            .catch((localSignError) => {
              console.warn("Client-side signing failed or private key not cached, falling back to server:", localSignError);
              fetch("/qz/sign", {
                method: "POST",
                headers: {
                  "Content-Type": "text/plain",
                },
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
      console.log("QZ Tray security configured successfully");
    };

    // Function to connect to QZ Tray
    const connect = async () => {
      const qz = await waitForQZ();

      if (!qz) {
        throw new Error(
          "QZ Tray library not loaded. Make sure qz-tray.js is included in assets.",
        );
      }

      // Configure security before connecting
      configureSecurity(qz);

      if (isConnected && qz.websocket.isActive()) {
        return;
      }

      try {
        await qz.websocket.connect({
          host: "localhost",
          port: {
            secure: [8181], // QZ Tray WSS port (confirmed active)
            insecure: [],   // Leave empty to block ws://
          },
          usingSecure: true, // Force wss://
          keepAlive: 60,
        });
        isConnected = true;
        console.log("QZ Tray connected successfully");
      } catch (e) {
        console.error("QZ Tray connection error:", e);
        throw e;
      }
    };

    // Function to print ZPL, HTML, or PDF
    const print = async (printerName, data, type = "pixel", options = {}, skipConnect = false) => {
      const qz = getQZ();
      if (!qz) {
        throw new Error("QZ Tray library not loaded.");
      }

      // Only connect if not already confirmed connected by caller
      if (!skipConnect) {
        await connect();
      }

      try {
        const config = qz.configs.create(printerName, {
          scaleContent: false,
          ...options,
        });

        // Example data payload structure
        // For PDF (base64): type='pixel', format='pdf', flavor='base64'
        // For Raw (ZPL/ESCP): type='raw', format='command', flavor='plain'

        const printData = [
          {
            type: type,
            format: type === "pixel" ? "html" : "command",
            flavor: type === "pixel" ? "plain" : "plain",
            data: data,
          },
        ];

        await qz.print(config, printData);
      } catch (e) {
        throw e;
      }
    };

    // Function to list printers (useful for configuration)
    const getPrinters = async () => {
      const qz = getQZ();
      if (!qz) {
        throw new Error("QZ Tray library not loaded.");
      }
      await connect();
      return await qz.printers.find();
    };

    return {
      connect,
      print,
      getPrinters,
      getQZ,
    };
  },
};

registry.category("services").add("qz_tray", qzTrayService);
