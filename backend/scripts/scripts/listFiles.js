import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

async function listFiles(bucketName) {
    console.log(`\n🔍 Listing items in bucket: ${bucketName}...`);

    // Explicitly listing the root directory
    const { data: files, error } = await supabase.storage.from(bucketName).list('', {
        limit: 100,
        offset: 0,
        sortBy: { column: 'name', order: 'asc' },
    });

    if (error) {
        console.error('❌ Error listing items:', error.message);
        return;
    }

    if (!files || files.length === 0) {
        console.log('⚠️ No items found in the root of this bucket.');
        return;
    }

    console.log(`\n✅ Found ${files.length} item(s):`);
    files.forEach(f => {
        // f.id is present for files, absent for folders in some versions of the API
        // Checking for metadata or specific properties
        const isFile = f.id || (f.metadata && f.metadata.size > 0);
        const type = isFile ? '📄 File' : '📁 Folder';
        const size = f.metadata ? `${(f.metadata.size / 1024).toFixed(2)} KB` : 'N/A';
        console.log(` - ${type}: ${f.name} (Size: ${size})`);
    });
    console.log('');
}

const bucket = process.argv[2] || 'MED_DATA';
listFiles(bucket).catch(err => {
    console.error('❌ Failed:', err);
    process.exit(1);
});
