<p align="center">
  <img src="magnoliaicon.png" alt="Magnolia" width="160">
</p>

# Magnolia: Free and powerful qualitative data analysis software

Use Magnolia at your own risk. Coded by Claude.

**Official website:** [www.caledavis.eu/magnolia.html](https://www.caledavis.eu/magnolia.html)

**Download the latest version:**

- [macOS — Apple Silicon](https://github.com/caledavis/Magnolia/releases/latest/download/Magnolia-mac-arm64.dmg)
- [macOS — Intel](https://github.com/caledavis/Magnolia/releases/latest/download/Magnolia-mac-x64.dmg)
- [Windows — Installer](https://github.com/caledavis/Magnolia/releases/latest/download/Magnolia-win-x64.exe)
- [Windows — Portable](https://github.com/caledavis/Magnolia/releases/latest/download/Magnolia-win-portable-x64.exe) (no installation or admin rights needed — ideal for managed or work computers)
- [Linux — AppImage](https://github.com/caledavis/Magnolia/releases/latest/download/Magnolia-linux-x86_64.AppImage) (see [Troubleshooting](#troubleshooting) if it fails to launch)
- [Linux — .deb](https://github.com/caledavis/Magnolia/releases/latest/download/Magnolia-linux-amd64.deb) (Debian/Ubuntu)
- [Linux — .rpm](https://github.com/caledavis/Magnolia/releases/latest/download/Magnolia-linux-x86_64.rpm) (Fedora/openSUSE/RHEL)

Magnolia is free and open-source qualitative data analysis software released under the European Union Public Licence (EUPL).

<p align="center">
  <img src="screenshot.png" alt="Magnolia" width="750">
</p>

It is designed to be powerful, while also intuitive.

Most existing qualitative data analysis software suffers from one of two problems. It is either:
- prohibitively expensive for many researchers and requires a subscription (costing upwards of 240 EUR per year!); or, 
- lacking the tools researchers need to analyse the data in the way they want.

Magnolia aims to address both of these problems. The principles of open science are not advanced if the tools people need to research are available only to those who can afford them.

Hopefully, Magnolia will allow you to regain some digital sovereignty over your research!

## Licence

Magnolia is free and released under the European Union Public Licence. This means that everyone is free to use Magnolia, reproduce it, change it, and make their changes available to others (among other things). Importantly, if Magnolia or a derivative of it is distributed, it must also be done under the EUPL licence and the source code must be made freely available.

This ensures that Magnolia remains free for everyone, and disincentivises companies from profiting off it.

## Powerful coding, powerful queries

Magnolia's intuitive, graphical query builder lets you build powerful queries to explore your data.

You can save your queries for later, and see the results update in real-time—even while coding data.

You can selectively apply queries to specific documents, types of documents, documents in specific folders, and/or documents with specific tags. 

## Memos and quotes

Magnolia allows you to attach memos to practically everything: the project itself, documents, parts of documents, queries, saved analyses, and within relationship maps. So if you have an idea, just note it down!

Magnolia's quote feature also allows you to easily save quotes for later, so you never need to worry about forgetting something interesting. Quotes can be text or even images!

## A rich suite of analysis tools

Magnolia's rich suite of analytical tools allow you to interrogate your data. You can selectively apply these tools to specific documents, types of documents, documents in specific folders, and/or documents with specific tags.  

<p align="center">
  <img src="screenshot3.png" alt="Magnolia" width="750">
</p>

- **Relationships:** Map anything and everything. Just drag it to the canvas! Everything on your canvas is interactive; just double-click and you will be taken there. You can even export your map as an SVG file.

- **Codes in Documents:** Easily see which codes exist in which documents.

- **Results in Documents:** Want to see how different queries produce different results? Easily see how many results different queries produce for each document in your project. 

- **Code Co-Occurrences:** See which codes overlap with each other. 

- **Code Orders:** Explore the order codes appear in your data. 

- **Code Frequencies:** Easily see how much of each document is covered by particular codes.

- **Word Frequencies:** See which words appear how often. See the data displayed as a chart or a word cloud.

## Easily transcribe audio and video

Transcribing audio and video makes it much easier to code.

Magnolia lets you transcribe audio and video. Naturally, you can do this with a foot pedal. Simply map keys to your foot pedal's buttons and then tell Magnolia that those keys are used to play, fast-forward, and rewind. Easy! There's no need for separate software.

Magnolia does not include AI transcription.

## Intuitive video coding

Qualitative researchers know that videos capture more than just words. The picture is also important! Because of this, Magnolia syncs your video codes to timestamps. 

This means that when you code a transcript, your codes also appear in the video timeline. If you code in the video timeline, your codes also appear in the transcript. The transcript and the video are linked!

## Support for survey data

<p align="center">
  <img src="screenshot2.png" alt="Magnolia" width="750">
</p>

Other QDA software breaks your survey responses into individual documents. Magnolia doesn't!

Magnolia's survey summary page allows you to easily see the results of your survey at a glance. See which percentage of respondents answered each question, or selected which options. Numerical data is presented as box plots (with the number of respondents, the mean, median, and mode). Go deeper into each respondent's answers, or compare how different respondents answered a question. 

You can also export a report with all your survey data.

## Native QDPX support

Magnolia reads and writes the QDPX format as standard. This is the open standard for qualitative data analysis. Other software defaults to proprietary formats. Magnolia does not!

Of course, there are some features in Magnolia which the QDPX format does not support. Magnolia overcomes this problem by including the Magnolia-specific features in a special part of the QDPX file. This means that other software (such as Atlas.ti and MAXQDA) can open Magnolia files without any problem, and will just ignore the Magnolia-specific features. 

## Supported document types

- Text: .txt, .md, .markdown, .pdf, .docx, .rtf, .odt (Magnolia converts .docx, .rtf, and .odt files to .pdf when they are imported)
- Images: .jpg, .jpeg, .png, .gif, .webp, .tif, .tiff, .heic, .heif 
- Audio: .wav, .mp3, .ogg, .flac, .m4a, .aac
- Video: .mp4, .mov, .avi
- Surveys: .csv, .xlsx

## No AI, no cloud, no subscription

Magnolia does not contain any AI features. There's no AI analysis, and no AI transcription. You are the researcher!

There's no cloud, so you can save your data where you want: locally, or on a network drive (multiple simultaneous users are not yet supported).

There is nothing in Magnolia which requires a subscription. 

## Troubleshooting

### Linux AppImage fails with "error loading libfuse.so.2"

AppImages need **libfuse2** to mount themselves at launch. Several recent
distros (Fedora 41+, Ubuntu 24.04+, and others) no longer ship it by default,
so the AppImage fails immediately with:

```
dlopen(): error loading libfuse.so.2
AppImages require FUSE to run.
```

Two ways to fix it:

- **Use the .deb or .rpm package instead** — they install their own
  dependencies automatically and don't need FUSE. See the download links
  above.
- **Or install libfuse2** and keep using the AppImage:
  - Fedora/RHEL: `sudo dnf install fuse-libs`
  - Ubuntu/Debian: `sudo apt install libfuse2`
  - Arch: `sudo pacman -S fuse2`
