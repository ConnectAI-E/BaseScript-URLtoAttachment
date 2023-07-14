
import { bitable, IOpenAttachment, FieldType, IWidgetTable } from "@base-open/web-api";
import { forceUpdateCom, getMoreConfig } from "./App";
import { downloadFile2 } from "./download";




/** 下载失败、上传失败、设置单元格失败的url */
export const downloadErr: {
    /** 失败了的url */
    [p: string]: {
        url: string;
        table: IWidgetTable;
        filename: string;
        /** 第一个引用这个的行id */
        recordId: string;
        fieldId: string;
        reason: any;
    };
} = {};

/** 下载成功，并且上传成功，并且设置到单元格成功过的url */
export const successSet = new Set<string>();

export const uploadSeccessSet: Set<string> = new Set();

export async function up({
    url,
    filename,
    fieldId,
    recordId,
    table,
}: {
    url: string;
    onProgress: (r: number) => any;
    filename: string;
    fieldId: string;
    recordId: string;
    table: IWidgetTable;
}) {
    const { cover } = getMoreConfig();
    if (cover) {
        const c = await table.getCellValue(fieldId, recordId);
        if (c) {
            return;
        }
    }
    return downloadFile2({
        url,
        filename,
    })
        .then((file) => {
            if (file) {
                return setFile({ file, fieldId, recordId, table, url });
            }
        })
        .catch((e) => {
            downloadErr[url] = { url, filename, fieldId, recordId, table, reason: e };
            forceUpdateCom();
        });
}


/** 每个文件上传状态,等到该文件上传，key为上传id，value为UploadStatusV */
const uploadStatus: {
    /** 上传id */
    [p: string]: UploadStatusV;
} = {};
interface UploadStatusV {
    /** 上传完成? */
    success: boolean;
    fileName: string;
    table: IWidgetTable;
    fieldId: string;
    /** 这个值已经设置过了 */
    settled: boolean;
    /** 每个文件下载的url */
    url: string;
    /** 上传id */
    id: string;
    /** 这个文件可以被直接用于设置单元格的值,单值，对象 */
    singleCellValue: any;
}

/** 用来保存每个单元格的最终需要被设置的值,在index中被初始化,单元格一旦被设置值，就会被删掉 */
export const recordValueCache: {
    /** 用来保存需要设置到那个单元格的值,key为tableId+recordId+fieldId，单元格一旦被设置值，就会被删掉,避免重复设置 */
    [p: string]: {
        /** 该单元格总共需要上传这么多个附件，在index中被初始化 */
        shouldLoadFile: number;
        /**这个单元格需要上传的附件以及它的状态；  */
        uploadStatus: UploadStatusV[];
    };
} = {};
/** key为url，值为对应的uploadId，和用到了这url的tableId+recordId的单元格，单于格所需的文件都被下载完了之后，将会删掉它们 */
export const urlUploadId: {
    /** key为url，值为对应的uploadId，fileName等信息 */
    [p: string]: {
        fileName?: string;
        uploadId?: string;
        /** 索引，使用了这个url作为附件的tableId+recordId+fieldId 使用;分隔,如果设置完了单元格的值，将会删这id，可以用于recordValueCache */
        tableRecord: Set<string>;
    };
} = {};

export function clearCache() {
    for (const key in urlUploadId) {
        delete urlUploadId[key];
    }
    for (const key in recordValueCache) {
        delete recordValueCache[key];
    }

    for (const key in downloadErr) {
        delete downloadErr[key];
    }

    for (const key in uploadStatus) {
        delete uploadStatus[key];
    }
    successSet.clear();
}

interface SetFile {
    /** 文件的url,相同的url认为是同一个文件，将不会下载多次 */
    url: string;
    file: File;
    fieldId: string;
    recordId: string;
    table: IWidgetTable;
}
/** 上传文件,*/
async function setFile({ file, fieldId, recordId, table, url }: SetFile) {
    const cacheKey = `${table.id}_${recordId}_${fieldId}`;

    for (const iterator of Object.values(uploadStatus)) {
        const { url: hisUrl } = iterator;
        if (url === hisUrl) {
            recordValueCache[cacheKey]?.uploadStatus.push(iterator);
            // 如果全部文件都走的缓存，则需要
            return checkFileDownloadAndSetCellValue({ url, fieldId, table });
        }
    }

    // 没上传过就开始上传文件
    const id = await bitable.base.uploadFile(file).catch((e) => {
        throw e;
    });
    urlUploadId[url].uploadId = id;
    urlUploadId[url].fileName = file.name;
    if (!uploadStatus[id]) {
        uploadStatus[id] = {
            success: false,
            fileName: file.name,
            fieldId,
            table,
            id,
            url,
            singleCellValue: undefined,
            settled: false,
        };
        recordValueCache[cacheKey].uploadStatus.push(uploadStatus[id]);
    }
    return new Promise((resolve, rej) => {
        ifFileUploadAndSetSuccess({ id, fileName: file.name, resolve });
    });
}
let off = () => {};

function ifFileUploadAndSetSuccess({
    id,
    fileName,
    resolve,
}: {
    id: string;
    fileName: string;
    resolve: (value: unknown) => void;
}) {
    off();
    off = bitable.base.onUploadStatusChange(getUploadStatusChange({ id, fileName, resolve }));
}

function getUploadStatusChange({
    id: currentUploadId,
    fileName: currentFileName,
    resolve,
}: {
    id: string;
    fileName: string;
    resolve: (value: unknown) => void;
}) {
    return async function uploadStatusChange(e: any) {
        const uploadFileId = e.data.id;

        const data = e.data;
        if (data) {
            // status为3的时候传输完成，出现token
            const uploadFileInfo = data.tasks.list[0];
            const token = uploadFileInfo.token; // status为3的时候出现token属性;
            const statusFileName = uploadFileInfo.name;
            if (token) {
                uploadSeccessSet.add(uploadFileInfo);
                if (!uploadStatus[uploadFileId]) {
                    return;
                }
                const { table, fieldId, settled, fileName } = uploadStatus[uploadFileId];
                if (settled) {
                    // 已经设置过的就不要再填上去了
                    return;
                }
                if (fileName !== statusFileName) {
                    // 通过id和url文件名获取到uploadId正确对应的token
                    // 未上传完成，这是api的bug，上传完成的是其他文件
                    return;
                }
                if (!(uploadFileId === currentUploadId && fileName === currentFileName)) {
                    // 等待当前文件上传完成
                    return;
                }
                uploadStatus[uploadFileId].settled = true;
                // 可用于“附件”类型的单元格的值
                const cellValue: IOpenAttachment = {
                    name: uploadFileInfo.name,
                    size: uploadFileInfo.size,
                    timeStamp: new Date().getTime(),
                    token,
                    type: uploadFileInfo.file.type,
                };

                uploadStatus[uploadFileId].singleCellValue = cellValue;
                uploadStatus[uploadFileId].success = true;
                // 每次文件上传完成的时候检查需要设置的值，如果走的是缓存，则不会触发这里，也就不会设置任何值
                const url = uploadStatus[uploadFileId].url;
                checkFileDownloadAndSetCellValue({ url, table, fieldId }).finally(() => {
                    // 遍历完成之后即开始下一个url的下载上传（未完成设置单元格）
                    resolve(true);
                });
            }
        }
    };
}

/** 找出用到了这个文件的单元格，检查它们所需的附件是否都上传好了，上传好了就设置这个单于格的值，然后在recordValueCache删掉它 */
export async function checkFileDownloadAndSetCellValue({
    url,
    table,
    fieldId,
}: {
    url: string;
    table: IWidgetTable;
    fieldId: string;
}) {
    const setCellTask: Promise<any>[] = [];
    urlUploadId[url].tableRecord.forEach((tableRecordId) => {
        const recordId = tableRecordId.split("_")[1];
        if (!recordValueCache[tableRecordId]) {
            return;
        }
        const cellFilestatus = recordValueCache[tableRecordId].uploadStatus;
        if (cellFilestatus.length >= recordValueCache[tableRecordId].shouldLoadFile) {
            // 表示数量已经达到
            if (cellFilestatus.every((s) => s.success)) {
                // 如果每个文件都上传成功了
                const allFiles = cellFilestatus.map((v) => v.singleCellValue);
                setCellTask.push(
                    table.getCellValue(fieldId, recordId).then((c) => {
                        let shouldSetCellValue = allFiles;
                        return table
                            .setCellValue(fieldId, recordId, shouldSetCellValue)
                            .then((r) => {
                                if (r) {
                                    cellFilestatus.forEach((cell) => {
                                        successSet.add(cell.url);
                                    });
                                    //  删掉那些已经上传成功的东西, set和recordValueCache
                                    delete recordValueCache[tableRecordId];
                                    urlUploadId[url].tableRecord.delete(tableRecordId);
                                    forceUpdateCom();
                                }
                            })
                            .catch((e) => {
                                console.error("设置失败", e);
                                // 再试一次
                                table
                                    .setCellValue(fieldId, recordId, shouldSetCellValue)
                                    .then((r) => {
                                        if (r) {
                                            cellFilestatus.forEach((cell) => {
                                                successSet.add(cell.url);
                                            });
                                            //  删掉那些已经上传成功的东西, set和recordValueCache
                                            delete recordValueCache[tableRecordId];
                                            urlUploadId[url].tableRecord.delete(tableRecordId);
                                            forceUpdateCom();
                                        }
                                    })
                                    .catch((e) => {
                                        console.error("重试失败", e);
                                    });
                            });
                    })
                );
            } else {
            }
        } else {
        }
    });
    await Promise.allSettled(setCellTask);
    return;
}




