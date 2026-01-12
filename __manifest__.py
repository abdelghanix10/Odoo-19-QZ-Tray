{
    'name': 'Odoo 19 QZ Tray Integration',
    'version': '1.0',
    'category': 'Hardware/Printing',
    'depends': ['web', 'point_of_sale'],
    'assets': {
        # Load QZ library in Backend
        'web.assets_backend': [
            'odoo_qz_print/static/lib/qz-tray.js',
            'odoo_qz_print/static/src/qz_service.js',
            'odoo_qz_print/static/src/print_icon.js',
            'odoo_qz_print/static/src/print_icon.xml',
        ],
        # Load QZ library in POS - CORRECT bundle name for Odoo 19
        'point_of_sale._assets_pos': [
            'odoo_qz_print/static/lib/qz-tray.js',
            'odoo_qz_print/static/src/qz_service.js',
            'odoo_qz_print/static/src/pos_qz_patch.js',
        ],
    },
    'installable': True,
    'license': 'LGPL-3',
}