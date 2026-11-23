package tz.co.brisksms.payment

/** One piece of text a notification carries, with the sender name it should be judged under. */
data class NotificationText(val sender: String, val body: String, val timestamp: Long? = null)

/**
 * A messaging app can put several texts in one notification: a grouped conversation, an inbox list, or a
 * structured message list whose sender differs from the notification title. Each is judged separately,
 * so a payment text is not lost because it shares a notification with another message.
 */
object NotificationTextExtractor {

    fun candidates(
        title: String,
        conversationTitle: String?,
        text: String,
        bigText: String,
        textLines: List<String>,
        messages: List<NotificationText>
    ): List<NotificationText> {
        val fallbackSender = if (title.isNotEmpty()) title else conversationTitle.orEmpty()
        val all = buildList {
            add(NotificationText(title, if (bigText.isNotEmpty()) bigText else text))
            addAll(messages.map { it.copy(sender = it.sender.ifEmpty { fallbackSender }) })
            addAll(textLines.map { NotificationText(fallbackSender, it) })
        }
        return all
            .map { it.copy(body = it.body.trim()) }
            .filter { it.body.isNotEmpty() }
            .distinctBy { it.sender to it.body }
    }
}
