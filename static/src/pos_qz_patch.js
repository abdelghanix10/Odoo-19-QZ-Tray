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
    const qzService = this.env.services.qz_tray;
    const printMethod = this.config?.receipt_print_method || "chrome";

    if (qzService && printMethod === "qz_tray") {
      // Printer resolution goes through qzService — handles caching, connection, retry
      const printerName = await qzService.getDefaultPrinter();

      // Render receipt HTML
      const renderer = this.env.services.renderer;
      const receiptHtml = await renderer.toHtml(
        OrderReceipt,
        {
          order,
          basic_receipt: basic,
        },
        { addClass: "pos-receipt-print" },
      );

      const htmlContent = `<html>
      <head>
        <style>
          body {
              font-family: "Courier New", Courier, monospace;
              font-weight: bold;
          }
          table {
              table-layout: fixed;
              width: 100%;
          }
          .pos-receipt-print {
              font-size: 14px;
          }
        </style>
      </head>
      <body>${receiptHtml.outerHTML}</body>
      </html>`;

      await qzService.print(printerName, htmlContent, "pixel", {});

      // Update print count (same logic as Odoo's original)
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

    return super.printReceipt({ basic, order, printBillActionTriggered });
  },
});
