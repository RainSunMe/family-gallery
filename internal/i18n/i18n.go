// Package i18n holds the bilingual message catalogue used by the API.
//
// English is the source language: every key must exist in English. Chinese is
// a full translation used when the client asks for "zh" or the operator sets
// DEFAULT_LANGUAGE=zh. Missing keys always fall back to English.
package i18n

import "strings"

// Lang is a supported language tag.
type Lang string

const (
	EN Lang = "en"
	ZH Lang = "zh"
)

// Catalog maps a language to its message table.
type Catalog map[Lang]map[string]string

var messages = Catalog{
	EN: {
		"admin_required":         "This action requires the admin password",
		"album_invalid":          "Please provide an album name under 40 characters and a description under 120 characters",
		"album_not_found":        "Album not found",
		"album_required":         "Please choose an album",
		"batch_limit":            "Batch upload limit reached, finish the current batch first",
		"collection_closed":      "This collection has ended",
		"collection_expired":     "Invitation expired",
		"collection_not_found":   "Collection not found",
		"collection_unavailable": "This collection has ended or the link is invalid",
		"derivative_not_ready":   "Preview upload is not complete yet, please retry",
		"download_forbidden":     "You cannot download this album",
		"download_not_found":     "Download task not found",
		"download_not_ready":     "Download package is not ready yet",
		"duplicate_photo":        "This photo is already in this album",
		"expiry_too_long":        "Expiry cannot exceed 365 days",
		"forbidden":              "This link cannot access that album",
		"internal_error":         "Service temporarily unavailable, please try again later",
		"invalid_collection":     "Please provide a valid topic and batch upload limit",
		"invalid_credentials":    "Incorrect password, please try again",
		"invalid_hash":           "The file could not be identified, please retry the upload",
		"invalid_selection":      "Please select between 1 and 500 items",
		"invalid_cursor":         "Invalid pagination cursor",
		"invalid_expiry":         "Invalid expiry",
		"invalid_file":           "Unsupported file type, empty file, or file exceeds the size limit",
		"invalid_file_limit":     "Unsupported file type or file exceeds the size limit",
		"invalid_name":           "Please enter a display name under 24 characters",
		"invalid_part":           "Invalid part number",
		"invalid_request":        "Invalid request content",
		"link_unavailable":       "This share link is no longer available",
		"multipart_incomplete":   "Parts are not fully uploaded yet, please retry",
		"no_downloadable":        "No downloadable photos",
		"not_found":              "Endpoint not found",
		"object_not_ready":       "File upload is not complete yet, please retry",
		"origin_rejected":        "Request origin is not trusted",
		"package_not_found":      "Download part not found",
		"photo_not_found":        "Photo not found or access denied",
		"photo_not_owned":        "This photo does not exist in the current album",
		"reopen_invite":          "Please reopen the invitation link",
		"revoke_own_share":       "You can only revoke shares you created",
		"session_required":       "Please enter your display name first",
		"share_not_found":        "Share not found",
		"target_album_missing":   "The target album does not exist",
		"too_many_attempts":      "Too many attempts, please try again later",
		"unauthenticated":        "Please enter the family password",
		"upload_expired":         "This upload has expired, please add the file again",
		"upload_finished":        "Upload already completed or missing",
		"upload_not_found":       "Multipart upload not found or already finished",
	},
	ZH: {
		"admin_required":         "此操作需要管理口令",
		"album_invalid":          "请输入不超过 40 字的相册名称和不超过 120 字的介绍",
		"album_not_found":        "相册不存在",
		"album_required":         "请选择相册",
		"batch_limit":            "已达到本次上传上限，请先完成当前批次",
		"collection_closed":      "这次收集已结束",
		"collection_expired":     "邀请已过期",
		"collection_not_found":   "收集不存在",
		"collection_unavailable": "这次照片收集已结束或链接无效",
		"derivative_not_ready":   "预览图尚未完整上传，请重试",
		"download_forbidden":     "无权下载此相册",
		"download_not_found":     "下载任务不存在",
		"download_not_ready":     "下载包尚未准备好",
		"duplicate_photo":        "这张照片已经在这个相册里了",
		"expiry_too_long":        "有效期不能超过 365 天",
		"forbidden":              "此链接不能访问该相册",
		"internal_error":         "服务暂时不可用，请稍后重试",
		"invalid_collection":     "请填写有效的主题与单批上传上限",
		"invalid_credentials":    "口令不正确，请重试",
		"invalid_hash":           "无法识别该文件，请重新上传",
		"invalid_selection":      "请选择 1 到 500 项",
		"invalid_cursor":         "分页游标无效",
		"invalid_expiry":         "有效期无效",
		"invalid_file":           "文件格式不支持、文件为空或超过大小上限",
		"invalid_file_limit":     "文件格式不支持或超过大小上限",
		"invalid_name":           "请填写不超过 24 字的称呼",
		"invalid_part":           "分片编号无效",
		"invalid_request":        "请求内容无效",
		"link_unavailable":       "此分享链接已失效",
		"multipart_incomplete":   "分片尚未完整上传，请重试",
		"no_downloadable":        "没有可下载的照片",
		"not_found":              "接口不存在",
		"object_not_ready":       "文件尚未完整上传，请重试",
		"origin_rejected":        "请求来源不受信任",
		"package_not_found":      "下载包不存在",
		"photo_not_found":        "照片不存在或无权访问",
		"photo_not_owned":        "这张照片不存在或不属于当前相册",
		"reopen_invite":          "请重新打开邀请链接",
		"revoke_own_share":       "只能撤销自己创建的分享",
		"session_required":       "请先填写你的称呼",
		"share_not_found":        "分享不存在",
		"target_album_missing":   "目标相册不存在",
		"too_many_attempts":      "尝试次数过多，请稍后再试",
		"unauthenticated":        "请输入共享口令",
		"upload_expired":         "这次上传已过期，请重新添加该文件",
		"upload_finished":        "上传已完成或不存在",
		"upload_not_found":       "分片上传不存在或已结束",
	},
}

// T returns the message for key in lang, falling back to English.
func T(lang Lang, key string) string {
	if table, ok := messages[lang]; ok {
		if value, ok := table[key]; ok {
			return value
		}
	}
	if value, ok := messages[EN][key]; ok {
		return value
	}
	return key
}

// Parse normalises a language tag. Unsupported values become EN.
func Parse(tag string) Lang {
	switch strings.ToLower(strings.TrimSpace(tag)) {
	case "zh", "zh-cn", "zh-hans":
		return ZH
	default:
		return EN
	}
}

// FromAcceptLanguage picks the best supported language from an
// Accept-Language header, defaulting to fallback.
func FromAcceptLanguage(header string, fallback Lang) Lang {
	for _, part := range strings.Split(header, ",") {
		tag := strings.TrimSpace(strings.SplitN(part, ";", 2)[0])
		if tag == "" {
			continue
		}
		if strings.HasPrefix(strings.ToLower(tag), "zh") {
			return ZH
		}
		if strings.HasPrefix(strings.ToLower(tag), "en") {
			return EN
		}
	}
	return fallback
}
