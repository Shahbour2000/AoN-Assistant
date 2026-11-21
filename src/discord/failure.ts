/**
 * What the player is told when answering failed. The real cause (with details) is always in the log; the player gets an accurate, specific
 * message rather than one generic sentence, so they know whether to retry now, wait, or tell an admin.
 */
export function failureMessage(failure: string, retryAfter?: number): string {
  switch (failure) {
    // Our own anti-spam gate (per user / whole bot): the player is sending messages very fast.
    case 'app_limit': return `بتبعت رسايل كتير ورا بعض 😅 استنى ${retryAfter ?? 30} ثانية وبعدين كمّل.`;
    // Every free AI service in the chain is unavailable. The wording follows how long the wait really is.
    case 'rate_limit': return rateLimitText(retryAfter);
    case 'timeout': case 'unavailable': case 'network': return 'خدمة الذكاء الاصطناعي مش بترد دلوقتي. جرّب تاني بعد شوية.';
    case 'unauthorized': case 'forbidden': return 'فيه مشكلة في مفتاح خدمة الذكاء الاصطناعي (غير صالح أو منتهي). لازم الأدمن يراجع إعدادات البوت.';
    case 'invalid_response': return 'الموديل رجّع رد فاضي أو غير مفهوم. ابعت سؤالك تاني، ولو اتكرر بلّغ الأدمن.';
    case 'bad_request': return 'الطلب كان كبير أو غير مقبول من خدمة الذكاء الاصطناعي. جرّب تسأل بشكل أقصر.';
    default: return 'حصل خطأ غير متوقع وأنا بجهّز الإجابة. جرّب تاني بعد شوية.';
  }
}

function rateLimitText(retryAfter?: number): string {
  if (!retryAfter) return 'كل خدمات الذكاء الاصطناعي المجانية مشغولة دلوقتي. جرّب تاني بعد شوية.';
  if (retryAfter <= 90) return `كل خدمات الذكاء الاصطناعي المجانية مشغولة لحظيًا (طلبات كتير في نفس الوقت). جرّب تاني بعد ${retryAfter} ثانية.`;
  if (retryAfter < 2 * 3600) return `كل خدمات الذكاء الاصطناعي المجانية وصلت للحد المؤقت. جرّب تاني بعد حوالي ${Math.ceil(retryAfter / 60)} دقيقة.`;
  return `الحصة المجانية اليومية لخدمات الذكاء الاصطناعي خلصت النهاردة. هترجع تشتغل تلقائيًا بعد حوالي ${Math.ceil(retryAfter / 3600)} ساعة.`;
}
