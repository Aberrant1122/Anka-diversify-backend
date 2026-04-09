export declare function detectType(mimetype: string): string;
export declare function generatePresignedUrl(projectId: string, filename: string, mimetype: string): Promise<{
    uploadUrl: string;
    fileUrl: string;
    key: string;
}>;
export declare function deleteFromS3(key: string): Promise<void>;
//# sourceMappingURL=upload.service.d.ts.map