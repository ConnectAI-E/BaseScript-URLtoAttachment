import { useState, useEffect, useRef, useMemo } from 'react'
import { up, recordValueCache, urlUploadId, downloadErr, successSet, clearCache } from './utils'
import { Form, Button, Toast, Banner, Spin, Tooltip } from '@douyinfe/semi-ui'
import { IFieldMeta as FieldMeta, IWidgetTable, FieldType, IOpenSegmentType, TableMeta, bitable } from '@base-open/web-api'
import './App.css'
import { icons } from './icons'
import { useTranslation } from 'react-i18next';


//@ts-ignore
window.bitable = bitable

let moreConfig = {
  /** 为true的时候表示，单元格如果有值，则不设置这个单元格,key为checkbox的value属性 */
  cover: true,
};

export function getMoreConfig() {
  return moreConfig;
}

export function setLoading(l: boolean) {
  loading = l;
  forceUpdateCom();
}

let loading = false;

let _forceUpdate: any;

export function forceUpdateCom() {
  return _forceUpdate({});
}

const END = "end";

const taskIterator = {
  /** 该数组的元素将直接塞给up函数 */
  allTasks: [],
  step: 1, // 由于uploadFile没有销毁注册过的监听事件，这里只能为1,每次上传1个文件，为每次上传文件进行监听,1次上传并设置一个单元格，好了再设置下一个
  *[Symbol.iterator]() {
    for (let index = 0; index < this.allTasks.length; index += this.step) {
      let task: any = this.allTasks.slice(index, index + this.step);
      task = Promise.allSettled(task.map((t: any) => up(t)));
      yield { task, range: index + "-" + (index + this.step) };
    }
    yield END;
  },
  allUrl: new Set(),
};

/** 表格，字段变化的时候刷新插件 */
export default function Ap() {
  const [key, setKey] = useState<string | number>(0);
  const [tableList, setTableList] = useState<IWidgetTable[]>([]);
  // 绑定过的tableId
  const bindList = useRef<Set<string>>(new Set());

  const refresh = useMemo(
    () => () => {
      const t = new Date().getTime();
      setKey(t);
    },
    []
  );

  useEffect(() => {
    bitable.base.getTableList().then((list) => {
      setTableList(list);
    });
    const deleteOff = bitable.base.onTableDelete(() => {
      setKey(new Date().getTime());
    });
    const addOff = bitable.base.onTableAdd(() => {
      setKey(new Date().getTime());
      bitable.base.getTableList().then((list) => {
        setTableList(list);
      });
    });
    return () => {
      deleteOff();
      addOff();
    };
  }, []);

  useEffect(() => {
    if (tableList.length) {
      tableList.forEach((table) => {
        if (bindList.current.has(table.id)) {
          return;
        }
        table.onFieldAdd(refresh);
        table.onFieldDelete(refresh);
        table.onFieldModify(refresh);
        bindList.current.add(table.id);
      });
    }
  }, [tableList]);

  return <UrlToFile key={key}></UrlToFile>;
}

function UrlToFile() {
  const { t } = useTranslation();
  const [btnDisabled, setBtnDisabled] = useState(true);
  const [tableMetaList, setTableMetaList] = useState<TableMeta[]>();
  const [tableLoading, setTableLoading] = useState(false)
  const [tableId, setTableId] = useState<string>();
  const formApi = useRef<any>();
  const [, f] = useState();
  _forceUpdate = f;
  const [table, setTable] = useState<IWidgetTable>();
  const filedInfo = useRef<{
    url: FieldMeta[];
    file: FieldMeta[];
  }>({ url: [], file: [] });

  useEffect(() => {
    setTableLoading(true)
    bitable.base.getTableMetaList().then(async (r) => {
      setTableMetaList(r.filter(({ name }) => name));
      const choosedTableId = (await bitable.base.getSelection()).tableId;
      formApi.current.setValues({
        table: choosedTableId,
        others: Object.entries(moreConfig)
          .filter(([k, v]) => v)
          .map(([k, v]) => k)
      });
      setTableId(choosedTableId!);
      setTableLoading(false)
    })
  }, []);

  const init = () => {
    clearCache();
    taskIterator.allUrl.clear();
    taskIterator.allTasks = [];
  }

  useEffect(() => {
    if (!tableId) {
      return;
    }
    setLoading(true);
    init();
    formApi.current.setValue("url", "");
    formApi.current.setValue("file", "");
    bitable.base.getTableById(tableId).then((table) => {
      setTable(table);
      const urlArr: FieldMeta[] = [];
      const fileArr: FieldMeta[] = [];
      table.getFieldMetaList().then((m) => {
        Promise.allSettled(
          m.map(async (meta) => {
            switch (meta.type) {
              case FieldType.Text:
              case FieldType.Url:
                urlArr.push(meta);
                break;
              case FieldType.Lookup:
              case FieldType.Formula:
                const field = await table.getFieldById(meta.id);
                const proxyType = await field.getProxyType();
                if (proxyType === FieldType.Text || proxyType === FieldType.Url) {
                  urlArr.push(meta);
                }
                break;
              case FieldType.Attachment:
                fileArr.push(meta);
                break;
              default:
                break;
            }
            return true;
          })
        ).finally(() => {
          filedInfo.current.url = urlArr;

          filedInfo.current.file = fileArr;

          setLoading(false)
          forceUpdateCom();
        });
      });
    });
  }, [tableId]);

  const onClickStart = async () => {
    const { url: urlFieldId, file: fileFieldId } = formApi.current.getValues();
    if (!fileFieldId) {
      Toast.error(t('choose.attachment'));
      return;
    }
    if (!urlFieldId) {
      Toast.error(t("err.url"));
      return;
    }
    if (!tableId) {
      Toast.error(t("err.table"));
      return;
    }
    setLoading(true);
    init();
    const table = await bitable.base.getTableById(tableId);
    const urlField = await table.getFieldById(urlFieldId);
    const urlValueList = await urlField.getFieldValueList();
    const allTasks: any = [];
    // 遍历url的字段，找出这些字段中的url,然后在recordValueCache记录它对应的附件字段单元格所需要的附件个数
    // 在urlUploadId统计每个url将被哪些附件单元格所需要，以避免重复下载url，上传文件
    // taskIterator记录每个url，单元格，创建转换任务的信息
    urlValueList.forEach(({ record_id, value }, index) => {
      const tableIdRecordId = `${table.id}_${record_id}_${fileFieldId}`;
      if (Array.isArray(value)) {
        value.forEach(({ type, link }: any) => {
          if (type === IOpenSegmentType.Url) {
            if (!recordValueCache[tableIdRecordId]) {
              recordValueCache[tableIdRecordId] = {
                shouldLoadFile: 1,
                uploadStatus: [],
              };
            } else {
              recordValueCache[tableIdRecordId].shouldLoadFile += 1;
            }
            if (!urlUploadId[link]) {
              urlUploadId[link] = {
                tableRecord: new Set([tableIdRecordId]),
              };
            } else {
              urlUploadId[link].tableRecord.add(tableIdRecordId);
            }

            allTasks.push({
              url: link,
              table,
              index,
              recordId: record_id,
              fieldId: fileFieldId,
              filename: link.split("/").slice(-1)[0].split("?")[0],
            });
            taskIterator.allUrl.add(link);
          }
        });
      }
    });
    taskIterator.allTasks = allTasks as any;
    _forceUpdate();
    // 开始转换任务
    for (const iterator of taskIterator) {
      if (iterator === END) {
        if (iterator === END) {
          setTimeout(() => {
            // 等浏览器处理完成
            setLoading(false);
          }, 100);
          setTimeout(() => {
            if (Object.keys(downloadErr).length) {
              Toast.error(t('some.err', { num: Object.keys(downloadErr).length }));
            } else {
              Toast.success(t('success'));
            }
          }, 500);
        }
      } else {
        await iterator.task;
      }
    }
  };

  const onFormChange = (e: any) => {
    const { table, url, file } = e.values;
    if (!table || !url || !file) {
      setBtnDisabled(true);
    } else {
      setBtnDisabled(false);
    }
  };


  return (
    <div>
      {/* 请设置url字段和保存附件的字段，即可批量处理 */}
      <Spin spinning={loading || tableLoading}>
        <Form
          onChange={onFormChange}
          disabled={loading}
          getFormApi={(e) => {
            formApi.current = e;
          }}
        >
          <Form.Select
            style={{ width: "100%" }}
            onChange={(tableId) => setTableId(tableId as string)}
            field="table"
            label={t('choose.table')}
          >
            {Array.isArray(tableMetaList) &&
              tableMetaList.map(({ id, name }) => (
                <Form.Select.Option key={id} value={id}>
                  <div className="semi-select-option-text">{name}</div>
                </Form.Select.Option>
              ))}
          </Form.Select>
          <Form.Select
            style={{ width: "100%" }}
            field="url"
            label={t('choose.url')}
            placeholder={t('choose')}
          >
            {filedInfo.current.url.map((m) => {
              return (
                <Form.Select.Option value={m.id} key={m.id}>
                  <div className="semi-select-option-text">
                    {/* @ts-ignore */}
                    {icons[m.type]}
                    {m.name}
                  </div>
                </Form.Select.Option>
              );
            })}
          </Form.Select>
          {filedInfo.current.file.length > 0 ? (
            <Form.Select
              style={{ width: "100%" }}
              field="file"
              label={t('to.attachment')}
              placeholder={t('choose')}
            >
              {filedInfo.current.file.map((m) => {
                return (
                  <Form.Select.Option value={m.id} key={m.id}>
                    <div className="semi-select-option-text">
                      {/* @ts-ignore */}
                      {icons[m.type]}
                      {m.name}
                    </div>
                  </Form.Select.Option>
                );
              })}
            </Form.Select>
          ) : (
            tableId && (
              <div>
                <Button
                  onClick={() => {
                    //@ts-ignore
                    table?.addField?.({
                      type: FieldType.Attachment,
                    });
                  }}
                >
                  {t('add.field')}
                </Button>
              </div>
            )
          )}
          <Form.CheckboxGroup
            onChange={(e) => {
              moreConfig = Object.fromEntries(e.map((k) => [k, true]));
              forceUpdateCom();
            }}
            field="others"
            label=" "
          >
            <Form.Checkbox value="cover">{t('with.field')}</Form.Checkbox>
          </Form.CheckboxGroup>

        </Form>
      </Spin> <br></br>
      <Button
        disabled={btnDisabled}
        type="primary"
        className="bt1"
        loading={loading}
        onClick={onClickStart}
      >
        {t('start.btn')}
      </Button>
      {/* 
            目前还不支持列出record所在的索引，后续支持的时候将会列出失败url以及它所在的行
            <div>
                <p>下载失败的url:</p>
                <div style={{ maxWidth: '90vw', overflow: 'auto' }} >
                    {Object.keys(downloadErr).map((k) => [<Tooltip content={<div>
                        {String(downloadErr[k].reason)}
                    </div>}><a href={k}>{k}</a></Tooltip>, <br></br>, <br />])}
                </div>
            </div> 
            */}
      {loading && taskIterator.allUrl.size > 0 && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            width: "100%",
            position: "fixed",
            top: "30px",
          }}
        >
          <div style={{ width: "280px" }}>
            <Banner
              style={{ flexGrow: 2 }}
              closeIcon={null}
              icon={null}
              fullMode={false}
              bordered
            >
              <div style={{ display: "flex", gap: "20px", justifyContent: "center" }}>
                <div style={{ marginLeft: 10 }}>
                  <Spin />
                </div>
                <div>
                  {t('trans.num', { num: `${successSet.size}/${taskIterator.allUrl.size}` })}
                </div>
              </div>
            </Banner>
          </div>
        </div>
      )}
    </div>
  );
}










