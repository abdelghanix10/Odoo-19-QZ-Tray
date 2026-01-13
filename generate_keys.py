#!/usr/bin/env python3
"""
Generate self-signed certificate and private key for QZ Tray integration.

This script generates:
1. A private key (private-key.pem)
2. A self-signed certificate (digital-certificate.txt)

Run this script once to generate the keys, then restart Odoo.

Usage:
    python generate_keys.py

The generated files will be placed in the 'keys' directory within this module.
"""

import os
import sys
from datetime import datetime, timedelta

try:
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.backends import default_backend
except ImportError:
    print("Error: 'cryptography' library is required.")
    print("Install it with: pip install cryptography")
    sys.exit(1)


def generate_keys():
    """Generate a self-signed certificate and private key for QZ Tray."""
    
    # Get the directory where this script is located
    script_dir = os.path.dirname(os.path.abspath(__file__))
    keys_dir = os.path.join(script_dir, 'keys')
    
    # Create keys directory if it doesn't exist
    os.makedirs(keys_dir, exist_ok=True)
    
    private_key_path = os.path.join(keys_dir, 'private-key.pem')
    certificate_path = os.path.join(keys_dir, 'digital-certificate.txt')
    
    print(f"Generating keys in: {keys_dir}")
    
    # Generate RSA private key (2048 bits)
    print("Generating RSA private key (2048 bits)...")
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
        backend=default_backend()
    )
    
    # Save private key (unencrypted PEM format)
    with open(private_key_path, 'wb') as f:
        f.write(private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption()
        ))
    print(f"Private key saved to: {private_key_path}")
    
    # Generate self-signed certificate
    print("Generating self-signed certificate...")
    
    # Certificate subject and issuer (same for self-signed)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
        x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "State"),
        x509.NameAttribute(NameOID.LOCALITY_NAME, "City"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Odoo QZ Print"),
        x509.NameAttribute(NameOID.COMMON_NAME, "localhost"),
    ])
    
    # Build certificate
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.utcnow())
        .not_valid_after(datetime.utcnow() + timedelta(days=3650))  # Valid for 10 years
        .add_extension(
            x509.BasicConstraints(ca=True, path_length=None),
            critical=True,
        )
        .sign(private_key, hashes.SHA256(), default_backend())
    )
    
    # Save certificate in PEM format
    with open(certificate_path, 'wb') as f:
        f.write(certificate.public_bytes(serialization.Encoding.PEM))
    print(f"Certificate saved to: {certificate_path}")
    
    print("\n" + "=" * 60)
    print("SUCCESS! Keys generated successfully.")
    print("=" * 60)
    print("\nNext steps:")
    print("1. Restart Odoo server")
    print("2. Install the certificate in QZ Tray:")
    print("   - Open QZ Tray")
    print("   - Right-click the QZ Tray icon in system tray")
    print("   - Go to 'Advanced' -> 'Site Manager'")
    print("   - Add your Odoo URL (e.g., http://localhost:8069)")
    print("   - Or trust the certificate when prompted by QZ Tray")
    print("=" * 60)
    

if __name__ == '__main__':
    generate_keys()
