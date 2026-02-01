/** @odoo-module */

import { PosStore } from "@point_of_sale/app/services/pos_store";
import { patch } from "@web/core/utils/patch";
import { OrderReceipt } from "@point_of_sale/app/screens/receipt_screen/receipt/order_receipt";

patch(PosStore.prototype, {
  async printReceipt({
    basic = false,
    order = this.getOrder(),
    printBillActionTriggered = false,
  } = {}) {
    // Try QZ Tray first
    const qzService = this.env.services.qz_tray;

    if (qzService) {
      try {
        // Connect to QZ Tray
        await qzService.connect();

        const qzLib = qzService.getQZ();
        if (qzLib) {
          // Get the renderer service from env
          const renderer = this.env.services.renderer;

          // Render receipt to HTML using Odoo's renderer
          const receiptHtml = await renderer.toHtml(
            OrderReceipt,
            {
              order,
              basic_receipt: basic,
            },
            { addClass: "pos-receipt-print" },
          );

          // Wrap in proper HTML document for printing
          const htmlContent = `<html>
          <head>
            <style>
              @font-face {
                  font-family: "DejaVu Sans Mono";
                  src: url("/odoo_qz_print/static/ttf/DejaVuSansMono.ttf") format("truetype");
                  font-weight: normal;
                  font-style: normal;
              }
              @font-face {
                  font-family: "DejaVu Sans Mono";
                  src: url("/odoo_qz_print/static/ttf/DejaVuSansMono-Bold.ttf") format("truetype");
                  font-weight: bold;
                  font-style: normal;
              }
              @font-face {
                  font-family: "DejaVu Sans Mono";
                  src: url("/odoo_qz_print/static/ttf/DejaVuSansMono-Oblique.ttf") format("truetype");
                  font-weight: normal;
                  font-style: italic;
              }
              @font-face {
                  font-family: "DejaVu Sans Mono";
                  src: url("/odoo_qz_print/static/ttf/DejaVuSansMono-BoldOblique.ttf") format("truetype");
                  font-weight: bold;
                  font-style: italic;
              }
              * {
                  font-family: "DejaVu Sans Mono", monospace;
              }
              table {
                  table-layout: fixed;
                  width: 100%;
              }
            </style>
          </head>
          <body>${receiptHtml.outerHTML}</body>
          </html>`;

          // Get default printer and print
          const printerName = await qzLib.printers.getDefault();
          await qzService.print(printerName, htmlContent, "pixel");

          // Update print count like original method does
          if (!printBillActionTriggered) {
            const count = order.nb_print ? order.nb_print + 1 : 1;
            if (order.isSynced) {
              const wasDirty = order.isDirty();
              await this.data.write("pos.order", [order.id], {
                nb_print: count,
              });
              if (!wasDirty) {
                order._dirty = false;
              }
            } else {
              order.nb_print = count;
            }
          } else if (!order.nb_print) {
            order.nb_print = 0;
          }

          return { successful: true };
        }
      } catch (error) {}
    }

    // Fallback to original Odoo printing
    return super.printReceipt({ basic, order, printBillActionTriggered });
  },
});
