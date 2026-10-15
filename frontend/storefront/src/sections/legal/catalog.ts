// Legal + contact sections (SEO round 1, WP4). DATA ONLY — no React imports.
//
// Pages: servd:privacy (/privacy), servd:terms (/terms), servd:contact
// (/contact). Each is a servd page the owner edits in Admin → Storefront and
// the CEO approves; with nothing published the routes render these defaults.
// The privacy and terms defaults are DRAFT wording (./policyText.ts) that opens
// with a "Draft — to be approved" note; clear that field once the wording is
// signed off.

import type { FieldSpec, PageDefault, SectionSpec } from '../types'
import {
  DRAFT_NOTE, PRIVACY_INTRO, PRIVACY_SECTIONS, TERMS_INTRO, TERMS_SECTIONS,
} from './policyText'

const GROUP = 'Legal & contact'

const documentFields: FieldSpec[] = [
  { key: 'draftNote', label: 'Draft note (top of page)', kind: 'textarea', rows: 3, hint: 'Shown in a box above the title. Empty it once the wording is approved by the owner / a lawyer.' },
  { key: 'eyebrow', label: 'Eyebrow', kind: 'text', hint: 'Empty = none.' },
  { key: 'title', label: 'Title (the page’s H1)', kind: 'text' },
  { key: 'updated', label: 'Last-updated line', kind: 'text', hint: 'e.g. “Last updated 14 October 2026”. Empty = none.' },
  { key: 'intro', label: 'Introduction', kind: 'textarea', rows: 4 },
  { key: 'numbered', label: 'Number the sections', kind: 'toggle' },
  { key: 'sections', label: 'Sections', kind: 'list', itemLabel: 'Section', max: 40,
    hint: 'Body is plain text: a blank line starts a new paragraph, a line starting with “- ” is a bullet.',
    item: [
      { key: 'heading', label: 'Heading', kind: 'text' },
      { key: 'body', label: 'Text', kind: 'textarea', rows: 8 },
    ] },
]

export const specs: SectionSpec[] = [
  {
    variant: 'legal.document',
    label: 'Policy document (privacy / terms)',
    group: GROUP,
    description: 'A draft-note box, the page title, an introduction and numbered sections of plain text.',
    icon: 'LG',
    pages: ['servd:privacy', 'servd:terms', 'servd:*', 'page:*'],
    summaryKey: 'title',
    fields: documentFields,
    defaults: {
      draftNote: DRAFT_NOTE,
      eyebrow: 'Legal',
      title: 'Privacy policy',
      updated: 'Draft of 14 October 2026',
      intro: PRIVACY_INTRO,
      numbered: true,
      sections: PRIVACY_SECTIONS.map((s) => ({ heading: s.heading, body: s.body })),
    },
  },
  {
    variant: 'legal.contactDetails',
    label: 'Contact details (company + each kitchen)',
    group: GROUP,
    description: 'The page’s H1 and how to reach servd, then a card per kitchen with its phone, WhatsApp, email and address from the brand records. Anything a kitchen has not filled in is left out.',
    icon: 'CD',
    pages: ['servd:contact', 'servd:*', 'page:*'],
    summaryKey: 'heading',
    fields: [
      { key: 'eyebrow', label: 'Eyebrow', kind: 'text', hint: 'Empty = none.' },
      { key: 'heading', label: 'Heading (the page’s H1)', kind: 'text' },
      { key: 'intro', label: 'Introduction', kind: 'textarea', rows: 3 },
      { key: 'companyName', label: 'Company name', kind: 'text' },
      { key: 'address', label: 'Company address', kind: 'text', hint: 'Empty = none.' },
      { key: 'email', label: 'Company email', kind: 'text' },
      { key: 'phone', label: 'Company phone', kind: 'text', hint: 'Empty = not shown. Type a real number only.' },
      { key: 'whatsapp', label: 'Company WhatsApp number', kind: 'text', hint: 'Digits with country code, e.g. 923001234567. Empty = not shown.' },
      { key: 'emailLabel', label: 'Label: email', kind: 'text' },
      { key: 'phoneLabel', label: 'Label: phone', kind: 'text' },
      { key: 'whatsappLabel', label: 'Label: WhatsApp', kind: 'text' },
      { key: 'addressLabel', label: 'Label: address', kind: 'text' },
      { key: 'mapLabel', label: 'Label: map link', kind: 'text' },
      { key: 'showKitchens', label: 'Show a card per kitchen', kind: 'toggle' },
      { key: 'kitchensHeading', label: 'Kitchens heading', kind: 'text', hint: 'Empty = none.' },
    ],
    defaults: {
      eyebrow: 'Contact',
      heading: 'Contact servd',
      intro: 'Questions about an order, catering, press or jobs? Message us below, or reach the kitchen directly with the phone, WhatsApp or address on its card. We are in Karachi.',
      companyName: 'GS Foods Pvt. Ltd.',
      address: 'Karachi, Pakistan',
      email: 'servd@gsfoods.pk',
      phone: '',
      whatsapp: '',
      emailLabel: 'Email',
      phoneLabel: 'Phone',
      whatsappLabel: 'WhatsApp',
      addressLabel: 'Address',
      mapLabel: 'Map',
      showKitchens: true,
      kitchensHeading: 'Our kitchens',
    },
  },
  {
    variant: 'legal.contactForm',
    label: 'Contact form',
    group: GROUP,
    description: 'Name, a phone or email to reply to, a topic, an optional kitchen and the message. It lands in Admin → Reviews → Messages for the kitchen’s company. Nothing is sent back automatically.',
    icon: 'CF',
    pages: ['servd:contact', 'servd:*', 'page:*'],
    summaryKey: 'heading',
    fields: [
      { key: 'heading', label: 'Heading', kind: 'text', hint: 'Empty = none.' },
      { key: 'intro', label: 'Introduction', kind: 'textarea', rows: 3 },
      { key: 'nameLabel', label: 'Label: name', kind: 'text' },
      { key: 'phoneLabel', label: 'Label: phone', kind: 'text' },
      { key: 'emailLabel', label: 'Label: email', kind: 'text' },
      { key: 'replyHint', label: 'Hint under the reply fields', kind: 'text' },
      { key: 'topicLabel', label: 'Label: topic', kind: 'text' },
      { key: 'topicPlaceholder', label: 'Topic placeholder', kind: 'text' },
      { key: 'topic_catering', label: 'Topic: catering', kind: 'text' },
      { key: 'topic_complaint', label: 'Topic: complaint', kind: 'text' },
      { key: 'topic_press', label: 'Topic: press', kind: 'text' },
      { key: 'topic_jobs', label: 'Topic: jobs', kind: 'text' },
      { key: 'topic_other', label: 'Topic: other', kind: 'text' },
      { key: 'brandLabel', label: 'Label: kitchen', kind: 'text' },
      { key: 'brandAny', label: 'Kitchen: none chosen', kind: 'text' },
      { key: 'messageLabel', label: 'Label: message', kind: 'text' },
      { key: 'sendText', label: 'Button', kind: 'text' },
      { key: 'sendingText', label: 'Button while sending', kind: 'text' },
      { key: 'privacyNote', label: 'Note under the button', kind: 'textarea', rows: 2 },
      { key: 'doneTitle', label: 'After sending: title', kind: 'text' },
      { key: 'doneBody', label: 'After sending: text', kind: 'textarea', rows: 3 },
      { key: 'errName', label: 'Error: name missing', kind: 'text' },
      { key: 'errReply', label: 'Error: no phone or email', kind: 'text' },
      { key: 'errTopic', label: 'Error: no topic', kind: 'text' },
      { key: 'errMessage', label: 'Error: message too short', kind: 'text' },
      { key: 'errLimit', label: 'Error: too many messages', kind: 'text' },
      { key: 'errGeneric', label: 'Error: something went wrong', kind: 'text' },
    ],
    defaults: {
      heading: 'Send us a message',
      intro: 'Tell us what you need and how to reach you. We read every message and reply by phone or email.',
      nameLabel: 'Your name',
      phoneLabel: 'Phone (to reply)',
      emailLabel: 'Email (to reply)',
      replyHint: 'Give at least one, so we can reply.',
      topicLabel: 'Topic',
      topicPlaceholder: 'Pick one',
      topic_catering: 'Catering and events',
      topic_complaint: 'A problem with an order',
      topic_press: 'Press and media',
      topic_jobs: 'Jobs',
      topic_other: 'Something else',
      brandLabel: 'Which kitchen? (optional)',
      brandAny: 'Not about one kitchen',
      messageLabel: 'Your message',
      sendText: 'Send message',
      sendingText: 'Sending…',
      privacyNote: 'We use your name and contact details only to answer you. See our privacy policy at servd.pk/privacy.',
      doneTitle: 'Message received.',
      doneBody: 'Thank you. Someone from the team will reply to the phone number or email you gave us.',
      errName: 'Please tell us your name.',
      errReply: 'Give a phone number or an email so we can reply.',
      errTopic: 'Please pick a topic.',
      errMessage: 'Please write at least a sentence.',
      errLimit: 'Too many messages from you just now. Please try again in an hour.',
      errGeneric: 'Something went wrong. Please try again, or use the phone or WhatsApp above.',
    },
  },
]

export const pages: PageDefault[] = [
  {
    slug: 'servd:privacy',
    sections: [{ variant: 'legal.document' }],
  },
  {
    slug: 'servd:terms',
    sections: [{
      variant: 'legal.document',
      fields: {
        title: 'Terms of service',
        intro: TERMS_INTRO,
        sections: TERMS_SECTIONS.map((s) => ({ heading: s.heading, body: s.body })),
      },
    }],
  },
  {
    slug: 'servd:contact',
    sections: [{ variant: 'legal.contactDetails' }, { variant: 'legal.contactForm' }],
  },
]
