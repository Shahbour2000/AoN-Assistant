/**
 * What the player is told when answering failed. The real cause (with details) is always in the log; the player gets an accurate, specific
 * message rather than one generic sentence, so they know whether to retry now, wait, or tell an admin.
 */
export function failureMessage(failure: string, retryAfter?: number): string {
  switch (failure) {
    case 'rate_limit': return retryAfter ? `المساعد وصل للحد المسموح به من الطلبات المجانية مؤقتًا. جرّب تاني بعد ${retryAfter} ثانية.` : 'المساعد وصل للحد المسموح به من الطلبات المجانية مؤقتًا. جرّب تاني بعد شوية.';
    case 'timeout': case 'unavailable': case 'network': return 'خدمة الذكاء الاصطناعي مش بترد دلوقتي. جرّب تاني بعد شوية.';
    case 'unauthorized': case 'forbidden': return 'فيه مشكلة في مفتاح خدمة الذكاء الاصطناعي (غير صالح أو منتهي). لازم الأدمن يراجع إعدادات البوت.';
    case 'invalid_response': return 'الموديل رجّع رد فاضي أو غير مفهوم. ابعت سؤالك تاني، ولو اتكرر بلّغ الأدمن.';
    case 'bad_request': return 'الطلب كان كبير أو غير مقبول من خدمة الذكاء الاصطناعي. جرّب تسأل بشكل أقصر.';
    default: return 'حصل خطأ غير متوقع وأنا بجهّز الإجابة. جرّب تاني بعد شوية.';
  }
}
