package tz.co.brisksms.worker

/** What is wrong with the relay right now, in words the owner can act on. Empty means healthy. */
object RelayHealth {
    const val STUCK_AFTER_MS = 30 * 60 * 1000L
    const val UPLOAD_STALLED_AFTER_MS = 60 * 60 * 1000L

    fun problems(
        isRevoked: Boolean,
        bulkMessagingEnabled: Boolean,
        simStateKnown: Boolean,
        activeSimCount: Int,
        queuedTooLong: Int,
        uploadsStalled: Int
    ): List<String> {
        if (isRevoked) return emptyList()
        val found = mutableListOf<String>()
        if (bulkMessagingEnabled && simStateKnown && activeSimCount == 0) {
            found += "No SIM card is ready, so messages cannot be sent."
        }
        if (bulkMessagingEnabled && queuedTooLong > 0) {
            found += "$queuedTooLong ${if (queuedTooLong == 1) "message has" else "messages have"} been waiting for more than 30 minutes."
        }
        if (uploadsStalled > 0) {
            found += "$uploadsStalled payment ${if (uploadsStalled == 1) "text has" else "texts have"} not reached your account for over an hour."
        }
        return found
    }
}
