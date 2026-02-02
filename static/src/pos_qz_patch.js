/** @odoo-module */

import { PosStore } from "@point_of_sale/app/services/pos_store";
import { patch } from "@web/core/utils/patch";
import { OrderReceipt } from "@point_of_sale/app/screens/receipt_screen/receipt/order_receipt";

// متغير خارجي لحفظ اسم الطابعة حتى لا نبحث عنها كل مرة
let cachedPrinterName = null;

patch(PosStore.prototype, {
  async printReceipt({
    basic = false,
    order = this.getOrder(),
    printBillActionTriggered = false,
  } = {}) {
    const qzService = this.env.services.qz_tray;

    if (qzService) {
      try {
        await qzService.connect();
        const qzLib = qzService.getQZ();

        if (qzLib) {
          const renderer = this.env.services.renderer;

          // تحويل الفاتورة لـ HTML
          const receiptHtml = await renderer.toHtml(
            OrderReceipt,
            {
              order,
              basic_receipt: basic,
            },
            { addClass: "pos-receipt-print" },
          );

          // تعديل: استخدام خطوط النظام (Monospace) بدلاً من تحميل خطوط من السيرفر لتسريع العملية
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
                  font-size: 14px; /* حجم خط مناسب للطابعات الحرارية */
              }
            </style>
          </head>
          <body>${receiptHtml.outerHTML}</body>
          </html>`;

          // تعديل: جلب الطابعة مرة واحدة فقط وحفظها
          if (!cachedPrinterName) {
            // يمكنك هنا وضع اسم الطابعة يدوياً إذا أردت سرعة قصوى
            // cachedPrinterName = "اسم الطابعة في الويندوز";
            cachedPrinterName = await qzLib.printers.getDefault();
            console.log("Printer cached:", cachedPrinterName);
          }

          // الطباعة باستخدام الاسم المحفوظ
          await qzService.print(cachedPrinterName, htmlContent, "pixel");

          // تحديث عداد الطباعة (نفس كود أودو الأصلي)
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
      } catch (error) {
        console.error("QZ Print Error:", error);
      }
    }

    return super.printReceipt({ basic, order, printBillActionTriggered });
  },
});
