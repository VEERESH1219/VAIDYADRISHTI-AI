import dns from 'dns';
import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

// Sanitization
Object.keys(process.env).forEach(key => {
    if (typeof process.env[key] === 'string') {
        process.env[key] = process.env[key].replace(/[^\x20-\x7E]/g, '').trim();
    }
});

const url = new URL(process.env.SUPABASE_URL);

console.log('🔍 Diagnostic Started');
console.log(`📡 URL: ${url.href}`);
console.log(`🌐 Host: ${url.hostname}`);

// 1. DNS Lookup
dns.lookup(url.hostname, (err, address, family) => {
    if (err) {
        console.error('❌ DNS Lookup Failed:', err.message);
    } else {
        console.log(`✅ DNS Lookup: ${address} (IPv${family})`);
    }

    // 2. HTTPS Get (Node native)
    console.log('⏳ Testing HTTPS connection (native)...');
    https.get(url.href, (res) => {
        console.log(`✅ HTTPS Status: ${res.statusCode}`);
    }).on('error', (e) => {
        console.error('❌ HTTPS Request Failed:', e.message);
    });

    // 3. Fetch Test
    console.log('⏳ Testing Fetch...');
    fetch(url.href)
        .then(res => console.log(`✅ Fetch Status: ${res.status}`))
        .catch(e => console.error('❌ Fetch Failed:', e.message));
});
