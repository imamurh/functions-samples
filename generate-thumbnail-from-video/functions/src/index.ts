import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
admin.initializeApp();
import * as storage from '@google-cloud/storage';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import mkdirp = require('mkdirp');

const TARGET_MIME_TYPE = 'video/mp4';
const STORAGE_TARGET_DIR = 'public/video';
const STORAGE_THUMBNAIL_DIR = 'public/video/thumbnail';
const DATABASE_DESTINATION = 'videos';

function validateObject(object: functions.storage.ObjectMetadata): boolean {
    const filePath = object.name || '';
    const fileDir = path.dirname(filePath);
    // Validate directory path.
    if (fileDir !== STORAGE_TARGET_DIR) {
        console.log(fileDir, ' is not a target directory.');
        return false;
    }
    // Validate MIME type.
    if (object.contentType !== TARGET_MIME_TYPE) {
        console.log('This is not a video.', object.contentType, object.name);
        return false;
    }
    return true
}

export const onVideoUpload = functions.region('asia-northeast1').storage.object().onFinalize(async (object) => {
    if (!validateObject(object)) {
        return
    }
    const filePath = object.name || '';
    const fileName = path.basename(filePath);
    const thumbnailPath = path.normalize(path.join(STORAGE_THUMBNAIL_DIR, fileName + '.jpg'));

    // Local temporary paths.
    const tmpPath = path.join(os.tmpdir(), filePath);
    const tmpDir = path.dirname(tmpPath);
    const tmpThumbnailPath = path.join(os.tmpdir(), thumbnailPath);
    const tmpThumbnailDir = path.dirname(tmpThumbnailPath);

    // Cloud Storage Bucket.
    const client = new storage.Storage();
    const bucket = client.bucket(object.bucket);

    // Hash for Document ID.
    const sha1 = crypto.createHash('sha1');
    sha1.update(filePath);
    const hash = sha1.digest('hex');

    // Create the temp directory where the storage file will be downloaded.
    await mkdirp(tmpDir);
    await mkdirp(tmpThumbnailDir);

    // Download file from bucket.
    await bucket.file(filePath).download({ destination: tmpPath });
    console.log('The file has been downloaded to', tmpPath);

    // Generate a thumbnail using ffmpeg.
    await generateThumbnail(tmpPath, tmpThumbnailPath);
    console.log('Thumbnail created at', tmpThumbnailPath);

    // Uploading the Thumbnail.
    await bucket.upload(tmpThumbnailPath, { destination: thumbnailPath, metadata: { contentType: 'image/jpeg' } });
    console.log('Thumbnail uploaded to Storage at', thumbnailPath);

    // Once the image has been uploaded delete the local files to free up disk space.
    fs.unlinkSync(tmpPath);
    fs.unlinkSync(tmpThumbnailPath);

    // Get the Signed URLs for the video and thumbnail.
    const results = await Promise.all([
        bucket.file(filePath).getSignedUrl({ action: 'read', expires: '03-01-2500' }),
        bucket.file(thumbnailPath).getSignedUrl({ action: 'read', expires: '03-01-2500' }),
    ]);
    const fileUrl = results[0][0];
    const thumbnailUrl = results[1][0];
    console.log('Got Signed URLs.');

    // Add the URLs to the Firestore.
    await admin.firestore().collection(DATABASE_DESTINATION).doc(hash).set({
        url: fileUrl,
        thumbnailUrl: thumbnailUrl,
        updated: new Date(),
    });
    console.log('The URLs saved to Firestore.');
});

export const onVideoDelete = functions.region('asia-northeast1').storage.object().onDelete(async (object) => {
    if (!validateObject(object)) {
        return
    }
    const filePath = object.name || '';
    const fileName = path.basename(filePath);
    const thumbnailPath = path.normalize(path.join(STORAGE_THUMBNAIL_DIR, fileName + '.jpg'));

    // Cloud Storage Bucket.
    const client = new storage.Storage();
    const bucket = client.bucket(object.bucket);

    // Hash for Document ID.
    const sha1 = crypto.createHash('sha1');
    sha1.update(filePath);
    const hash = sha1.digest('hex');

    // Deleting the Thumbnail.
    await bucket.file(thumbnailPath).delete();
    console.log('Thumbnail deleted from Storage at', thumbnailPath);

    // Deleting the Document from Firestore.
    await admin.firestore().collection(DATABASE_DESTINATION).doc(hash).delete();
    console.log('Document deleted from Firestore.', hash);
});

// ffmpeg
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpeg_static from 'ffmpeg-static';
import * as ffprobe_static from 'ffprobe-static';
ffmpeg.setFfmpegPath(ffmpeg_static.path);
ffmpeg.setFfprobePath(ffprobe_static.path);

function generateThumbnail(inputFile: string, outputFile: string) {
    const outputDir = path.dirname(outputFile);
    const outputFileName = path.basename(outputFile);

    return new Promise((resolve, reject) => {
        ffmpeg(inputFile)
            .on('end', function () {
                resolve();
            })
            .screenshots({
                timestamps: [1],
                filename: outputFileName,
                folder: outputDir
            });
    });
}
