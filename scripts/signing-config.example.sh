#!/bin/bash

# MailVault Signing Configuration - EXAMPLE
# ==========================================
# Copy this file to signing-config.sh and fill in your credentials:
#   cp scripts/signing-config.example.sh scripts/signing-config.sh
#
# Then edit scripts/signing-config.sh with your real values.
# The signing-config.sh file is gitignored and will not be committed.

# Your Apple ID email
APPLE_ID="your@email.com"

# Your Team ID (found at https://developer.apple.com/account -> Membership)
TEAM_ID="YOUR_TEAM_ID"

# App-specific password (create at https://appleid.apple.com -> Security -> App-Specific Passwords)
APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"

# Keychain profile name (used to store credentials securely)
NOTARYTOOL_PROFILE="notarytool-profile"

# Optional: Override signing identities (leave empty to auto-detect)
# DEVELOPER_ID_APPLICATION="Developer ID Application: Your Name (TEAM_ID)"
# DEVELOPER_ID_INSTALLER="Developer ID Installer: Your Name (TEAM_ID)"
# APPLE_DISTRIBUTION="Apple Distribution: Your Name (TEAM_ID)"
# MAC_INSTALLER_DISTRIBUTION="3rd Party Mac Developer Installer: Your Name (TEAM_ID)"
