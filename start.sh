#!/bin/bash
set -e

echo "📦 Installing Python 3 and pip3 manually..."

apt update && apt install -y python3 python3-pip

echo "📦 Installing Python dependencies..."
pip3 install --upgrade pip
pip3 install -r /home/site/wwwroot/python/requirements.txt

echo "🚀 Starting Node.js server..."
npm start