# Grouping

The `Grouped by` function is common to several analysis tools. It allows you to conveniently group your results.

## Default state
By default, your results are not grouped unless you specify otherwise. This means that you will see the results for each individual document.

Surveys and [notebooks](/guide/notes) are the exception. When the [Document Selector](/guide/documentselector) targets a survey or a note, Magnolia adds a chip to `Grouped by` for each survey and each notebook:

| Chip | What it does |
| --- | --- |
| The survey's name, followed by `respondents` | Shows the survey as a single column, with all of its respondents together. |
| The notebook's name | Shows the notebook as a single column, with all of its notes together. |

Your other documents keep their own columns.

**To see a column for each respondent or note:**

1. Click the `×` on the survey's or notebook's chip in `Grouped by`.

2. The survey is shown with a column for each respondent, or the notebook with a column for each note, followed by a `Subtotal`.

::: info
The reason for this is simply that if survey results were not grouped by respondent, your results table would consider each respondent's answers to be a document in itself and make a separate column for each survey respondent. The results can then become very long (a survey with 50 respondents, for example, would have a column for each respondent!). Notebooks work the same way, so that a notebook with many notes does not fill your table either.
:::

To limit a survey to some of its questions or respondents, choose them in the [Document Selector](/guide/documentselector#survey-questions-and-respondents).
