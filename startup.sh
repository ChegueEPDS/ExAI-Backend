#!/bin/bash

# Python requirements telepítése
echo "Installing Python dependencies..."
pip3 install -r python/requirements.txt

# Node.js app indítása
echo "Starting Node.js app..."
npm start