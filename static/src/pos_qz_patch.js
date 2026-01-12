/** @odoo-module */

import { ReceiptScreen } from "@point_of_sale/app/screens/receipt_screen/receipt_screen";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";

patch(ReceiptScreen.prototype, {
  setup() {
    super.setup();
    this.qz = useService("qz_tray");
  },

  async printReceipt() {
    // 1. Check if QZ is connected
    try {
      // Locate the Receipt HTML element in the POS
      // Odoo 17/18/19 usually renders receipt in .pos-receipt-container
      const receiptElement = document.querySelector(".pos-receipt-container");

      if (!receiptElement) {
        console.warn(
          "QZ: Receipt element not found, falling back to browser print."
        );
        return super.printReceipt();
      }

      // 2. Prepare the HTML for QZ
      // We wrap it in standard HTML tags and add basic width styling
      const htmlContent = `
                <html>
                <head>
                    <style>
                        body { 
                            font-family: 'Inconsolata'; 
                            font-size: 14px;
                            width: 300px; /* Standard thermal width */
                            margin: 0;
                        }
                        .pos-receipt {
                            width: 100%;
                        }
                        img { max-width: 100%; }
                        .pos-receipt-container { text-align: center; }
                    </style>
                </head>
                <body>
                    ${receiptElement.innerHTML}
                </body>
                </html>
            `;

      // 3. Send to Printer via QZ
      // Ensure we are connected before asking for printers
      await this.qz.connect();

      // Get QZ library from window
      const qzLib = this.qz.getQZ();

      if (!qzLib) {
        console.warn("QZ Library not loaded, falling back to browser print.");
        return super.printReceipt();
      }

      const printerName = await qzLib.printers.getDefault();

      console.log(`QZ: Printing POS receipt to ${printerName}...`);
      await this.qz.print(printerName, htmlContent, "pixel");

      return true;
    } catch (error) {
      console.error("QZ Printing Failed:", error);
      // If QZ fails, fallback to the standard browser print so the user isn't stuck
      return super.printReceipt();
    }
  },
});
