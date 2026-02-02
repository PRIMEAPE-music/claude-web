#!/bin/bash
# Install claude-web as a systemd service

set -e

SERVICE_FILE="claude-web.service"
SERVICE_PATH="/etc/systemd/system/$SERVICE_FILE"

echo "Installing Claude Web systemd service..."

# Copy service file
sudo cp "$SERVICE_FILE" "$SERVICE_PATH"
sudo chmod 644 "$SERVICE_PATH"

# Reload systemd
sudo systemctl daemon-reload

# Enable service (start on boot)
sudo systemctl enable claude-web

# Start service now
sudo systemctl start claude-web

# Show status
echo ""
echo "Claude Web service installed and started!"
echo ""
systemctl status claude-web --no-pager

echo ""
echo "Useful commands:"
echo "  sudo systemctl status claude-web   # Check status"
echo "  sudo systemctl restart claude-web  # Restart"
echo "  sudo systemctl stop claude-web     # Stop"
echo "  sudo systemctl disable claude-web  # Disable auto-start"
echo "  journalctl -u claude-web -f        # View logs"
