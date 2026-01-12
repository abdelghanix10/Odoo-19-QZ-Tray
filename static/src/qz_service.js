/** @odoo-module **/

import { registry } from "@web/core/registry";

export const qzTrayService = {
  async start(env) {
    let isConnected = false;

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

    // Function to connect to QZ Tray
    const connect = async () => {
      const qz = await waitForQZ();

      if (!qz) {
        throw new Error(
          "QZ Tray library not loaded. Make sure qz-tray.js is included in assets."
        );
      }

      if (isConnected && qz.websocket.isActive()) {
        return;
      }

      try {
        await qz.websocket.connect();
        isConnected = true;
      } catch (e) {
        throw e;
      }
    };

    // Function to print ZPL, HTML, or PDF
    const print = async (printerName, data, type = "pixel") => {
      const qz = getQZ();
      if (!qz) {
        throw new Error("QZ Tray library not loaded.");
      }

      await connect();

      try {
        const config = qz.configs.create(printerName);

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
