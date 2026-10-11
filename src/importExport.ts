import cloneDeep from "lodash/cloneDeep";
import QRCode from "qrcode";

import { getShrinkedSettings as getShrinkedSettingsOnedriveFull } from "../pro/src/fsOnedriveFull";
import {
  COMMAND_URI,
  type QRExportType,
  type RemotelySavePluginSettings,
} from "./baseTypes";
import { getShrinkedSettings as getShrinkedSettingsOnedrive } from "./fsOnedrive";
import { validateImportedSettings } from "./settingsImportValidation";

export const exportQrCodeUri = async (
  settings: RemotelySavePluginSettings,
  currentVaultName: string,
  pluginVersion: string,
  exportFields: QRExportType
) => {
  let settings2: Partial<RemotelySavePluginSettings> = {};

  if (exportFields === "basic_and_advanced") {
    settings2 = cloneDeep(settings);
    delete settings2.s3;
    delete settings2.dropbox;
    delete settings2.onedrive;
    delete settings2.onedrivefull;
    delete settings2.webdav;
    delete settings2.webdis;
    delete settings2.googledrive;
    delete settings2.box;
    delete settings2.pcloud;
    delete settings2.yandexdisk;
    delete settings2.koofr;
    delete settings2.azureblobstorage;
    delete settings2.pro;
  } else if (exportFields === "s3") {
    settings2 = { s3: cloneDeep(settings.s3) };
  } else if (exportFields === "dropbox") {
    settings2 = { dropbox: cloneDeep(settings.dropbox) };
  } else if (exportFields === "onedrive") {
    settings2 = { onedrive: getShrinkedSettingsOnedrive(settings.onedrive) };
  } else if (exportFields === "onedrivefull") {
    settings2 = {
      onedrivefull: getShrinkedSettingsOnedriveFull(settings.onedrivefull),
    };
  } else if (exportFields === "webdav") {
    settings2 = { webdav: cloneDeep(settings.webdav) };
  } else if (exportFields === "webdis") {
    settings2 = { webdis: cloneDeep(settings.webdis) };
  } else if (exportFields === "googledrive") {
    settings2 = { googledrive: cloneDeep(settings.googledrive) };
  } else if (exportFields === "box") {
    settings2 = { box: cloneDeep(settings.box) };
  } else if (exportFields === "pcloud") {
    settings2 = { pcloud: cloneDeep(settings.pcloud) };
  } else if (exportFields === "yandexdisk") {
    settings2 = { yandexdisk: cloneDeep(settings.yandexdisk) };
  } else if (exportFields === "koofr") {
    settings2 = { koofr: cloneDeep(settings.koofr) };
  } else if (exportFields === "azureblobstorage") {
    settings2 = { azureblobstorage: cloneDeep(settings.azureblobstorage) };
  }

  delete settings2.vaultRandomID;
  const data = encodeURIComponent(JSON.stringify(settings2));
  const vault = encodeURIComponent(currentVaultName);
  const version = encodeURIComponent(pluginVersion);
  const rawUri = `obsidian://${COMMAND_URI}?func=settings&version=${version}&vault=${vault}&data=${data}`;
  // console.info(uri)
  const imgUri = await QRCode.toDataURL(rawUri);
  return {
    rawUri,
    imgUri,
  };
};

export interface ProcessQrCodeResultType {
  status: "error" | "ok";
  message: string;
  result?: Partial<RemotelySavePluginSettings>;
}

/**
 * we also support directly parse the uri, instead of relying on web browser
 * @param input
 */
export const parseUriByHand = (input: string) => {
  if (!input.startsWith("obsidian://remotely-save?func=settings&")) {
    throw Error(`not valid string`);
  }

  const k = new URL(input);
  const output = Object.fromEntries(k.searchParams);
  return output;
};

export const importQrCodeUri = (
  inputParams: any,
  currentVaultName: string
): ProcessQrCodeResultType => {
  const params = inputParams;
  if (
    params === null ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    params.func !== "settings" ||
    typeof params.vault !== "string" ||
    typeof params.data !== "string" ||
    params.data.length > 1024 * 1024
  ) {
    return {
      status: "error",
      message: "Invalid settings import link.",
    };
  }

  if (params.vault !== currentVaultName) {
    return {
      status: "error",
      message: "The settings import targets a different vault.",
    };
  }

  let settings: Partial<RemotelySavePluginSettings>;
  try {
    settings = validateImportedSettings(JSON.parse(params.data));
  } catch (e) {
    return {
      status: "error",
      message: "Invalid settings import: check its fields and values.",
    };
  }
  return {
    status: "ok",
    message: "ok",
    result: settings,
  };
};
