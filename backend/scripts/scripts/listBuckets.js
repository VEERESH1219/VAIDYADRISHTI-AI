import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

async function listBuckets() {
    console.log('\n🔍 Listing Supabase Storage Buckets...');

    const { data: buckets, error } = await supabase.storage.listBuckets();

    if (error) {
        console.error('❌ Error listing buckets:', error.message);
        return;
    }

    if (!buckets || buckets.length === 0) {
        console.log('⚠️ No buckets found.');
        return;
    }

    console.log(`\n✅ Found ${buckets.length} bucket(s):`);
    buckets.forEach(b => {
        console.log(` - 📦 ${b.name} (Public: ${b.public})`);
    });
    console.log('');
}

listBuckets().catch(err => {
    console.error('❌ Failed:', err);
    process.exit(1);
});
