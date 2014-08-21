# EBUI is an Email-Based User Interface

## Entity inboxes

Each (top-level) business entity has a corresponding email inbox:

- ticket-\<application\>@\<domain\>...
- expense-\<application\>@\<domain\>...
- todo-\<application\>@\<domain\>...

## Instance creation

Whenever an email is sent to one of those entity inboxes, a new instance of that entity is created (if all required information is present in the message). The server replies with either a confirmation email where the from: address corresponds to the instance created, or an error message explaining why creation failed.

## Instance update

A user can perform an update to a business entity instance by replying to the email that was sent during creation.

## Note on security

From: addresses can be easily spoofed. There is no mechanism in EBUI yet for safely authenticating senders, hence it should not be used as is to perform operations that would require any sort of privilege. Implementation of a proper authentication mechanism is left as an exercise to the reader.
