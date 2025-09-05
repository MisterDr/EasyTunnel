#!/bin/bash

# HTunnel SSL Setup Script using HTTP challenge
echo "HTunnel SSL Setup - HTTP Challenge Method"
echo "========================================"

echo "This method uses HTTP-01 challenge instead of DNS-01"
echo "You'll need to get certificates for each subdomain individually."
echo ""

# First get certificate for the main domain
echo "Step 1: Get certificate for main domain:"
echo "sudo certbot --nginx -d blablabla.me"
echo ""

echo "Step 2: For wildcard support, you still need DNS challenge:"
echo "sudo certbot certonly --manual --preferred-challenges dns -d '*.blablabla.me' -d 'blablabla.me'"
echo ""

echo "Alternative: Use specific subdomains as needed:"
echo "sudo certbot --nginx -d tunnel1.blablabla.me -d tunnel2.blablabla.me"
echo ""

echo "After getting certificates, uncomment the HTTPS section in nginx config."