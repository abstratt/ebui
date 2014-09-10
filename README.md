## EBUI is an Email-Based User Interface

[![Build Status](https://textuml.ci.cloudbees.com/buildStatus/icon?job=ebui)](https://textuml.ci.cloudbees.com/job/ebui/)

EBUI is an Email-Based User Interface for business applications. It acts as a transactional email front-end to any application that implements a [Kirra-compliant](http://abstratt.github.io/kirra/) REST API.

### Try it!

You can try EBUI against a Cloudfier example application named Ship-it!, a simple issue tracking application.

#### Creating an issue

Send an email like this:

To: issue.demo-cloudfier-examples-shipit-plus@inbox.cloudfier.com

Subject: allow reporting issues via email

Body:

    When I send an email, an issue should be automatically created. Just like this one I am sending now. 
    The subject should become the summary, and this text should become the description.
    --
    Severity: Enhancement
    Project: Cloudfier issues
    Reporter: rafael@abstratt.com
    --
    
After a while (1 minute), you should get a confirmation message:

    This is an automated response to your message to issue.demo-cloudfier-examples-shipit-plus@inbox.cloudfier.com
    
    Message successfully processed. Object was created.
    
    Summary: allow reporting issues via email
    Issue Id: 60
    Issue Key: CLD-60
    Reported On: 2014-09-09T00:00Z
    Severity: Major
    Status: Open
    Waiting For: 1 day(s)
    Description:
    When I send an email, an issue should be automatically created. Just like
    this one I am sending now.
    
    The subject should become the summary, and this text should become the
    description. Please?
    
    -------------------------------
    
    Use this link to edit it:
    
    http://develop.cloudfier.com//kirra-api/kirra_qooxdoo/build/?app-path=/services/api-v2/demo-cloudfier-examples-shipit-plus#%2Fentities%2Fshipit.Issue%2Finstances%2F59

#### Updating an issue

Reply to the creation confirmation message with these contents:

    We will be happy to take a community contribution for this one.
    Just let me know.
    
    BTW, this is not a major issue, but a feature request. Changing severity.
    
    -- 
    severity: Enhancement
    labels: bountyavailable

which will change the severity to Enhancement, link to an existing label "bountyavailable" and add a child Comment instance to the Issue instance.

### Status

This is still an experiment. What is working:
- can create a new business entity instance
- on creation, subject and body fill in for missing required string/memo properties)
- can update an existing business entity instance
- on update, body will result in a new instance of a *comment-like child entity* (an entity with a memo field and no other required fields) to be created
- can invoke actions with or without arguments
- can refer (link) to instances of related entities using their shorthand

Interested? Please join by contributing code, bugs, feature requests etc.

### How does it work?

#### Entity inboxes

Each (top-level) business entity has a corresponding email inbox:

- ticket-\<application\>@\<domain\>...
- expense-\<application\>@\<domain\>...
- todo-\<application\>@\<domain\>...
- ...


#### Instance creation

Whenever an email is sent to one of those entity inboxes, a new instance of that entity is created (if all required information is present in the message). The server replies with either a confirmation email where the from: address corresponds to the instance created, or an error message explaining why creation failed.

#### Replies to the instance creation thread

For childless entities, a user can perform an update to a business entity instance by replying to the email that was sent in response to an instance creation. For entities that aggregate a single kind of child entity that has a required Memo field, responses to the creation email are considered creation of instances of child objects.

#### Email body contents

Email body contents (the email text) map to the first Memo property in the corresponding entity. 

#### Email attachments

Email attachments map to the first Blob property in the corresponding entity. 

#### Setting properties

Properties can be set on creation or update using the following syntax in the body of an email:

    Thanks for your report. I was able to reproduce it locally, and agree it is a 
    dangerous bug. We will fix it right away.
    --
    Priority: High
    Assignee: Jenniffer Strong
    Fix for: v2.1.1


#### Invoking actions

Actions can be explicitly invoked on an object by using the following syntax:

    --
    Done:

which would send the "Done" message to the target object. If the action has parameters, the following syntax can be used:

    --
    Reject:
      Reason: Expenses on entertainment are not reimbursable.

or (for passing a single argument):
    --
    Reject: Expenses on entertainment are not reimbursable.

which would send the "Reject" message with the shown message as an argument for the 'reason' parameter. 


#### A note on sender authentication

*From:* addresses can be easily spoofed. There is no mechanism in EBUI yet for safely authenticating senders, hence it should not be used as-is to perform operations that would require any sort of privilege (applications should consider EBUI-originated commands to be from unauthenticated users). Implementation of a proper authentication mechanism is required for any applications where spoofing would not be tolerable and is currently left as an exercise to the reader.

![Built on DEV@Cloud](http://cloudbees.prod.acquia-sites.com/sites/default/files/styles/large/public/Button-Built-on-CB-1.png)
